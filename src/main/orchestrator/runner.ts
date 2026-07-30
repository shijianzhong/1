import type {
  MessageEnvelope,
  OrchMessage,
  StreamEvent,
  WorkflowContext,
} from '@shared/types'
import type { Executor, RuntimeWorkflow } from './models'
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
      ctx.onEvent({
        type: 'output',
        node_id: ctx.source ?? '',
        speaker: ctx.source ?? '',
        text,
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
      parent.onEvent({
        type: 'output',
        node_id: source,
        speaker: source,
        text,
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
  return {
    role: m.role ?? 'user',
    author: m.author,
    content: m.content ?? '',
    toolUseId: m.toolUseId,
    isFunctionResult: m.isFunctionResult,
  }
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

  try {
    // should_respond=true → 触发 handle；false → 仅 extend cache（broadcast 模式）
    // TODO(M4 收口)：仍硬编码 true；GroupChat 广播须由 envelope/pattern 设 false（铁律 15，见 task.md）
    const req = { messages, shouldRespond: true }
    const eventStream = executor.handle(req, ctx)
    for await (const event of eventStream) {
      onEvent(event)
    }
    onEvent({ type: 'node_done', node_id: executor.id })

    // handle 后 fan-out 给下游（非定向消息走边）
    const edges = wf.edges.get(executor.id) ?? []
    const conditions = wf.conditions.get(executor.id) ?? []
    if (edges.length > 0 || conditions.length > 0) {
      // 取 executor cache 最后产出作为下游输入
      const lastMsg = executor.cache[executor.cache.length - 1]
      if (lastMsg) {
        if (conditions.length > 0) {
          // 条件边：求值谓词，只走第一个匹配的
          for (const c of conditions) {
            if (evaluatePredicate(c.predicate, lastMsg.content)) {
              await ctx.send_message(
                { ...lastMsg, author: executor.id },
                c.target,
              )
              break
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
