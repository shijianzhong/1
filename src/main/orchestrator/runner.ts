import type {
  MessageEnvelope,
  OrchMessage,
  StreamEvent,
  WorkflowContext,
} from '@shared/types'
import type { Executor, RuntimeWorkflow } from './models'
import { ConcurrentExecutor } from './patterns/concurrent'
import { logger } from '../logger'

// —— Pregel superstep 执行模型（§三之三 E + 铁律7）——
// N emit / N+1 deliver；同 superstep 内所有收到消息的 executor 并发（Promise.all）。
// 不是递归（GroupChat 的 should_respond=false 广播依赖 superstep 语义，§三 D）。

const MAX_SUPERSTEPS = 50 // 防死循环兜底

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

  let iteration = 0
  while (iteration < MAX_SUPERSTEPS) {
    if (signal?.aborted) {
      onEvent({ type: 'failed', error: 'aborted' })
      return { output: ctx.output.join('\n') }
    }

    if (ctx.pending.length === 0) {
      // 无 pending 消息 → 收敛
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
        await deliverToExecutor(executor, envelopes, executorCtx, wf, onEvent, signal)
      }),
    )

    // —— Concurrent fan-in 栅栏（等齐再聚合，铁律：fan-in 等 all 到齐）——
    // 每个 superstep 结束后扫描 concurrent 容器：所有 participant 都已有
    // assistant 产出（cache 里 role==='assistant'）→ 拼合成一条消息投给 aggregator。
    for (const [id, ex] of wf.executors) {
      if (!(ex instanceof ConcurrentExecutor)) continue
      if (aggregatedConc.has(id)) continue
      const participantIds = ex.participantIds
      const allDone = participantIds.every((pid) => {
        const pEx = wf.executors.get(pid)
        return pEx?.cache.some((m) => m.role === 'assistant')
      })
      if (!allDone || participantIds.length === 0) continue
      // 拼合各 participant 最后一条 assistant
      const parts: string[] = []
      for (const pid of participantIds) {
        const pEx = wf.executors.get(pid)
        const lastAssistant = [...(pEx?.cache ?? [])]
          .reverse()
          .find((m) => m.role === 'assistant')
        parts.push(`【${pid}】\n${lastAssistant?.content ?? ''}`)
      }
      const joined = parts.join('\n\n')
      aggregatedConc.add(id)
      ctx.pending.push({
        source: id,
        target: ex.aggregatorId,
        message: { role: 'user', content: joined, shouldRespond: true },
        targeted: true,
      })
    }

    iteration++
  }

  if (iteration >= MAX_SUPERSTEPS) {
    onEvent({ type: 'failed', error: `超过最大 superstep 数 ${MAX_SUPERSTEPS}` })
  }

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
  _signal?: AbortSignal,
): Promise<void> {
  onEvent({ type: 'node_started', node_id: executor.id })

  // extend cache（所有消息都进 cache，铁律15）
  const messages = envelopes.map((e) => e.message)
  executor.cache.push(...messages)

  // shouldRespond 双语义（铁律15）：任一 envelope 显式 false 且全部显式 false
  // → 仅 extend cache（broadcast 模式）；否则默认 true 触发 handle。
  // 语义：GroupChat 广播发 false，定向请求发 true；targeted 边 fan-out 默认 true。
  const anyExplicitFalse = envelopes.some((e) => e.message.shouldRespond === false)
  const allExplicitFalse = envelopes.every((e) => e.message.shouldRespond === false)
  const shouldRespond = !(anyExplicitFalse && allExplicitFalse)

  try {
    const req = { messages, shouldRespond }
    const eventStream = executor.handle(req, ctx)
    for await (const event of eventStream) {
      onEvent(event)
    }
    onEvent({ type: 'node_done', node_id: executor.id })

    // handle 后 fan-out 给下游（非定向消息走边）
    // broadcast（shouldRespond=false）仅 extend cache，不再 fan-out——
    // 否则 GroupChat 广播一次就会把下游全部触发（§三 D broadcast 语义）。
    if (!shouldRespond) return
    const edges = wf.edges.get(executor.id) ?? []
    const conditions = wf.conditions.get(executor.id) ?? []
    if (edges.length > 0 || conditions.length > 0) {
      // 取 executor cache 最后产出作为下游输入
      const lastMsg = executor.cache[executor.cache.length - 1]
      if (lastMsg) {
        if (conditions.length > 0) {
          // 条件边（switch-case 语义，§三之三 B）：求值谓词，走第一个匹配的；
          // 全不命中 → 走无 condition 的普通边兜底（默认分支）。
          let matched = false
          for (const c of conditions) {
            if (evaluatePredicate(c.predicate, lastMsg.content)) {
              await ctx.send_message(
                { ...lastMsg, author: executor.id },
                c.target,
              )
              matched = true
              break
            }
          }
          if (!matched) {
            for (const target of edges) {
              await ctx.send_message(
                { ...lastMsg, author: executor.id },
                target,
              )
            }
          }
        } else {
          // 普通边：fan-out 给所有下游（下一 superstep deliver）
          for (const target of edges) {
            await ctx.send_message(
              { ...lastMsg, author: executor.id },
              target,
            )
          }
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
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
