import type {
  MessageEnvelope,
  OrchMessage,
  StreamEvent,
  WorkflowContext,
} from '@shared/types'
import type { Executor, RuntimeWorkflow } from './models'
import { ConcurrentExecutor } from './patterns/concurrent'
import { AgentExecutor } from './patterns/agent'
import { logger } from '../logger'

// —— Pregel superstep 执行模型（§三之三 E + 铁律7）——
// N emit / N+1 deliver；同 superstep 内所有收到消息的 executor 并发（Promise.all）。
// 不是递归（GroupChat 的 should_respond=false 广播依赖 superstep 语义，§三 D）。

const MAX_SUPERSTEPS = 50 // 防死循环兜底

// executor cache 软上限：超出后保留首条 + 最近 N 条（见 deliverToExecutor）
const CACHE_SOFT_CAP = 200

interface WorkflowContextImpl extends WorkflowContext {
  source: string | null
  pending: MessageEnvelope[] // 当前轮待投递 + 下一轮累积（N emit / N+1 deliver）
  output: string[]
  onEvent: (e: StreamEvent) => void
}

function createWorkflowContext(
  wf: RuntimeWorkflow,
  onEvent: (e: StreamEvent) => void,
): WorkflowContextImpl {
  const ctx: WorkflowContextImpl = {
    source: null,
    pending: [],
    output: [],
    onEvent,
    async send_message(data, target_id) {
      const message = toOrchMessage(data)
      // N emit / N+1 deliver：emit 的消息入 pending，下个 superstep 才 deliver
      ctx.pending.push({
        source: ctx.source,
        target: target_id ?? '',
        message,
        targeted: !!target_id,
      })
    },
    async yield_output(data) {
      const text = typeof data === 'string' ? data : JSON.stringify(data)
      ctx.output.push(text)
      // 空文本不发 output 事件（防 final 替换把流式气泡清空成空气泡；
      // 如 thinking-only 响应 finalText 为空的边缘场景）
      if (!text) return
      ctx.onEvent({
        type: 'output',
        node_id: ctx.source ?? '',
        speaker: ctx.source ?? '',
        text,
        final: true, // 终端完整输出（前端替换末条气泡，与流式增量区分去重）
      })
    },
    async add_event(e) {
      ctx.onEvent(e)
    },
    get_source_executor_id() {
      return ctx.source ?? ''
    },
  }
  return ctx
}

/**
 * 创建子上下文：固定 source 为指定 executor id，共享 pending/output/onEvent。
 * 解决并发 Promise.all 中 ctx.source 被互相覆盖的竞态问题。
 */
function createChildContext(parent: WorkflowContextImpl, source: string): WorkflowContextImpl {
  return {
    source,
    pending: parent.pending, // 共享引用：parent.pending 被重新赋值时，send_message 仍读 parent.pending
    output: parent.output,
    onEvent: parent.onEvent,
    async send_message(data, target_id) {
      const message = toOrchMessage(data)
      parent.pending.push({
        source,
        target: target_id ?? '',
        message,
        targeted: !!target_id,
      })
    },
    async yield_output(data) {
      const text = typeof data === 'string' ? data : JSON.stringify(data)
      parent.output.push(text)
      if (!text) return
      parent.onEvent({
        type: 'output',
        node_id: source,
        speaker: source,
        text,
        final: true,
      })
    },
    async add_event(e) {
      parent.onEvent(e)
    },
    get_source_executor_id() {
      return source
    },
  }
}

function toOrchMessage(data: unknown): OrchMessage {
  if (typeof data === 'string') {
    return { role: 'user', content: data }
  }
  const m = data as Partial<OrchMessage>
  const msg: OrchMessage = {
    role: m.role ?? 'user',
    author: m.author,
    content: m.content ?? '',
    toolUseId: m.toolUseId,
    isFunctionResult: m.isFunctionResult,
  }
  // shouldRespond 是 runner 投递语义（铁律15），不是业务消息字段——
  // 单独携带，不落 executor.cache（避免广播消息污染 cache）
  if (m.shouldRespond !== undefined) {
    Object.defineProperty(msg, 'shouldRespond', {
      value: m.shouldRespond,
      enumerable: false,
    })
  }
  return msg
}

/**
 * 运行 workflow（Pregel 主循环，非递归）。
 * @param onEvent 推 StreamEvent 给前端
 */
export async function runWorkflow(
  wf: RuntimeWorkflow,
  input: { text: string; sessionId?: string },
  onEvent: (e: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<{ output: string }> {
  const ctx = createWorkflowContext(wf, onEvent)
  const edgeCount = [...wf.edges.values()].reduce((n, arr) => n + arr.length, 0)
  logger.info(
    `[trace:cap] runner.start session=${input.sessionId ?? '-'} ` +
      `start=${wf.startExecutor} executors=${wf.executors.size} edges=${edgeCount} ` +
      `inputLen=${input.text.length}`,
  )

  // 初始消息投递到 startExecutor
  ctx.source = null
  ctx.pending.push({
    source: null,
    target: wf.startExecutor,
    message: { role: 'user', content: input.text },
    targeted: true,
  })

  // Concurrent fan-in 栅栏：跟踪已聚合的容器 id，防重复聚合
  const aggregatedConc = new Set<string>()

  // executor 失败记录（id → 错误信息）：participant 失败时 fan-in 栅栏把它视为
  // 「已结束」，容错聚合已有结果 + 失败标注——否则失败 participant 永远没有 assistant
  // 产出，栅栏永不满足，pending 清空后 workflow 静默提前收敛、聚合结果整体丢失。
  const failedNodes = new Map<string, string>()

  let iteration = 0
  let stopReason: 'converged' | 'max_supersteps' | 'aborted' = 'converged'
  while (iteration < MAX_SUPERSTEPS) {
    if (signal?.aborted) {
      stopReason = 'aborted'
      logger.warn(`[trace:cap] runner.abort superstep=${iteration} pending=${ctx.pending.length}`)
      onEvent({ type: 'failed', error: 'aborted' })
      return { output: ctx.output.join('\n') }
    }

    if (ctx.pending.length === 0) {
      // 无 pending 消息 → 收敛
      stopReason = 'converged'
      break
    }

    // drain 本 superstep 待投递消息：取出当前轮，清空 pending。
    // 处理期间 send_message 往 ctx.pending push（下轮 deliver，N emit / N+1 deliver）。
    const pending = ctx.pending
    ctx.pending = []

    // 按 target executor 分组（同一 executor 收到多条消息合并投递）
    const byTarget = new Map<string, MessageEnvelope[]>()
    for (const env of pending) {
      const list = byTarget.get(env.target) ?? []
      list.push(env)
      byTarget.set(env.target, list)
    }

    logger.info(
      `[trace:cap] runner.superstep=${iteration} deliver=[${[...byTarget.keys()].join(',')}] ` +
        `envelopes=${pending.length}`,
    )

    // 同 superstep 内所有 target executor 并发 deliver（Promise.all，铁律7）
    await Promise.all(
      Array.from(byTarget.entries()).map(async ([targetId, envelopes]) => {
        const executor = wf.executors.get(targetId)
        if (!executor) {
          logger.warn(`[runner] 未找到 executor ${targetId}，跳过`)
          return
        }
        // 为每个并发 executor 创建独立子上下文，避免 source 互相覆盖
        const executorCtx = createChildContext(ctx, targetId)
        await deliverToExecutor(executor, envelopes, executorCtx, wf, onEvent, failedNodes, signal)
      }),
    )

    // —— Concurrent fan-in 栅栏（等齐再聚合，铁律：fan-in 等 all 到齐）——
    // 每个 superstep 结束后扫描 concurrent 容器：所有 participant 都已有
    // assistant 产出（cache 里 role==='assistant'）→ 拼合成一条消息投给 aggregator。
    // 容错：participant 失败（failedNodes 有记录）视为「已结束」，聚合时标注失败原因，
    // 不再等一个永远等不到的产出（旧行为：静默提前收敛、聚合丢失）。
    for (const [id, ex] of wf.executors) {
      if (!(ex instanceof ConcurrentExecutor)) continue
      if (aggregatedConc.has(id)) continue
      const participantIds = ex.participantIds
      const allDone = participantIds.every((pid) => {
        if (failedNodes.has(pid)) return true
        const pEx = wf.executors.get(pid)
        return pEx?.cache.some((m) => m.role === 'assistant')
      })
      if (!allDone || participantIds.length === 0) continue
      // 拼合各 participant 最后一条 assistant；前缀原始任务（容器 cache 首条 user
      // 消息），否则 aggregator 只拿到调研碎片、丢失用户最初意图
      const firstUser = ex.cache.find((m) => m.role === 'user')
      const parts: string[] = []
      for (const pid of participantIds) {
        const failReason = failedNodes.get(pid)
        if (failReason !== undefined) {
          parts.push(`【${pid}】\n（执行失败：${failReason}）`)
          continue
        }
        const pEx = wf.executors.get(pid)
        const lastAssistant = [...(pEx?.cache ?? [])]
          .reverse()
          .find((m) => m.role === 'assistant')
        parts.push(`【${pid}】\n${lastAssistant?.content ?? ''}`)
      }
      const joined =
        (firstUser?.content ? `任务：${firstUser.content}\n\n` : '') + parts.join('\n\n')
      aggregatedConc.add(id)
      // 投递目标 = aggregator + 容器其它下游边（Set 去重；容器→aggregator 视觉边
      // builder 已跳过，这里再兜底排除一次防双投）。
      // 语义：容器的出边 = 「本阶段完成后流转到 X」，统一在等齐后投聚合结果。
      const targets = new Set<string>([ex.aggregatorId, ...(wf.edges.get(id) ?? [])])
      logger.info(
        `[trace:cap] runner.fanin concurrent=${id} → [${[...targets].join(',')}] ` +
          `joinedLen=${joined.length} failed=[${[...failedNodes.keys()].join(',')}]`,
      )
      for (const target of targets) {
        ctx.pending.push({
          source: id,
          target,
          message: { role: 'user', content: joined, shouldRespond: true },
          targeted: true,
        })
      }
    }

    iteration++
  }

  if (iteration >= MAX_SUPERSTEPS) {
    stopReason = 'max_supersteps'
    onEvent({ type: 'failed', error: `超过最大 superstep 数 ${MAX_SUPERSTEPS}` })
  }

  logger.info(
    `[trace:cap] runner.end reason=${stopReason} supersteps=${iteration} ` +
      `outputLen=${ctx.output.join('\n').length} failed=${failedNodes.size}` +
      (failedNodes.size
        ? ` detail=${JSON.stringify(Object.fromEntries(failedNodes))}`
        : ''),
  )
  onEvent({ type: 'done' })
  return { output: ctx.output.join('\n') }
}

/** 把消息投递给 executor（fan-out 处理 + 条件边路由） */
async function deliverToExecutor(
  executor: Executor,
  envelopes: MessageEnvelope[],
  ctx: WorkflowContextImpl,
  wf: RuntimeWorkflow,
  onEvent: (e: StreamEvent) => void,
  failedNodes: Map<string, string>,
  signal?: AbortSignal,
): Promise<void> {
  onEvent({ type: 'node_started', node_id: executor.id })
  const deliverStarted = Date.now()

  // extend cache（所有消息都进 cache，铁律15）
  const messages = envelopes.map((e) => e.message)
  executor.cache.push(...messages)
  // cache 软上限：防长会话（GroupChat 多轮广播）单 executor cache 无界膨胀超
  // context window。超限保留首条（原始任务锚点）+ 最近 N 条——对应 CLAUDE.md
  // 「compaction 先用简单截断保留最近 N 条」的 MVP 取舍，完整 compaction 后置。
  if (executor.cache.length > CACHE_SOFT_CAP) {
    executor.cache = [executor.cache[0], ...executor.cache.slice(-(CACHE_SOFT_CAP - 1))]
  }

  // shouldRespond 双语义（铁律15）：任一 envelope 显式 false 且全部显式 false
  // → 仅 extend cache（broadcast 模式）；否则默认 true 触发 handle。
  // 语义：GroupChat 广播发 false，定向请求发 true；targeted 边 fan-out 默认 true。
  const anyExplicitFalse = envelopes.some((e) => e.message.shouldRespond === false)
  const allExplicitFalse = envelopes.every((e) => e.message.shouldRespond === false)
  const shouldRespond = !(anyExplicitFalse && allExplicitFalse)
  logger.info(
    `[trace:cap] node.start id=${executor.id} shouldRespond=${shouldRespond} ` +
      `cache=${executor.cache.length} envelopes=${envelopes.length}`,
  )

  try {
    const req = { messages, shouldRespond }
    const eventStream = executor.handle(req, ctx)
    for await (const event of eventStream) {
      // 取消提速：abort 到达时停止消费当前 executor 的事件流（for-await break
      // 会调 generator.return() 终止流），不必等整个 chunk 流吐完
      if (signal?.aborted) {
        logger.warn(`[trace:cap] node.abort_mid_stream id=${executor.id}`)
        break
      }
      onEvent(event)
    }
    onEvent({ type: 'node_done', node_id: executor.id })
    logger.info(
      `[trace:cap] node.done id=${executor.id} ms=${Date.now() - deliverStarted} aborted=${!!signal?.aborted}`,
    )

    // 已取消：不再 fan-out 触发下游——否则 abort 在 handle 期间到达时，
    // 下游仍会被这次投递点燃，取消语义漏到下一个 superstep 顶部才生效
    if (signal?.aborted) return

    // handle 后 fan-out 给下游（非定向消息走边）
    // broadcast（shouldRespond=false）仅 extend cache，不再 fan-out——
    // 否则 GroupChat 广播一次就会把下游全部触发（§三 D broadcast 语义）。
    if (!shouldRespond) return
    // Concurrent 容器是纯 dispatcher（handle 只做 fan-out 分发，瞬间完成）：
    // 它的 cache 末条还是「原始输入」，此时走边 fan-out 会把原始输入直接发给下游，
    // 下游与 participant 同 superstep 并发开跑、拿不到调研结果（实测 bug：
    // 写作 agent 与调研同跑，反手问用户要写什么）。下游统一由 fan-in 栅栏
    // 等齐后投聚合结果（见主循环栅栏段）。
    if (executor instanceof ConcurrentExecutor) return
    const edges = wf.edges.get(executor.id) ?? []
    const conditions = wf.conditions.get(executor.id) ?? []
    if (edges.length > 0 || conditions.length > 0) {
      const lastMsg = executor.cache[executor.cache.length - 1]
      if (lastMsg) {
        logger.info(
          `[trace:cap] node.fanout id=${executor.id} edges=[${edges.join(',')}] ` +
            `conds=${conditions.length} lastLen=${String(lastMsg.content ?? '').length}`,
        )
        // 转发载荷（§G full_conversation 保真）：AgentExecutor 把完整 cache 转发下游——
        // 下游 extend 后能看到原始任务 + 所有上游产出，而非仅末条。
        // （顺序管线「调研→拆解→写作」里，写作必须同时看到调研与拆解两份结果；
        //  只转末条会让写作丢失调研上下文，退化去反问用户。）
        // 容器 executor（groupchat/handoff）保持末条：其 cache 是整段聊天历史，全量转发会灌爆下游。
        // 注意：菱形汇聚（两上游 cache 含相同前缀）会产生重复消息，MVP 接受（图多为线性）。
        const payload: OrchMessage[] =
          executor instanceof AgentExecutor
            ? executor.cache
            : [{ ...lastMsg, author: executor.id }]
        const sendPayload = async (target: string): Promise<void> => {
          for (const m of payload) {
            await ctx.send_message(m, target)
          }
        }
        if (conditions.length > 0) {
          // 条件边（switch-case 语义，§三之三 B）：谓词对本 executor 末条产出求值，
          // 走第一个匹配的；全不命中 → 走无 condition 的普通边兜底（默认分支）。
          let matched = false
          for (const c of conditions) {
            if (evaluatePredicate(c.predicate, lastMsg.content)) {
              await sendPayload(c.target)
              matched = true
              break
            }
          }
          if (!matched) {
            for (const target of edges) {
              await sendPayload(target)
            }
          }
        } else {
          // 普通边：fan-out 给所有下游（下一 superstep deliver）
          for (const target of edges) {
            await sendPayload(target)
          }
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 记录失败：fan-in 栅栏据此容错聚合；下游普通边不 fan-out（上游失败下游无从继续），
    // 前端经 node_error 事件可见
    failedNodes.set(executor.id, message)
    logger.error(
      `[trace:cap] node.error id=${executor.id} ms=${Date.now() - deliverStarted} err=${message}`,
    )
    onEvent({ type: 'node_error', node_id: executor.id, error: message })
  }
}

/** 条件边谓词求值（MVP 仅 contains:，§三之三 B） */
function evaluatePredicate(predicate: string, content: string): boolean {
  if (predicate === 'always' || predicate === '') return true
  if (predicate.startsWith('contains:')) {
    const sub = predicate.slice('contains:'.length).trim()
    return content.includes(sub)
  }
  return false
}
