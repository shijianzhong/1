import type { GraphNode, StreamEvent, WorkflowContext } from '@shared/types'
import type { Executor } from '../models'
import type { AgentExecutorOptions } from './agent'
import { AgentExecutor } from './agent'

// —— Concurrent pattern（§三 D + §三之三 G）——
// dispatcher fan-out 给所有 participant（同 superstep 并发）；
// fan-in 等 all 到齐再调 aggregator 取每个最后 assistant msg 拼合。
//
// builder 职责：注册所有 participant + aggregator + Concurrent 容器，
// 配 fan-in 边（each→aggregator）。fan-out 由 ConcurrentExecutor.handle 内部
// 调 ctx.send_message 实现，不再额外配 container→participant 边（避免 runner
// fan-out 与 handle fan-out 重复投递导致 participant 收到双份消息）。

export interface ConcurrentConfig {
  participants: string[]
}

/** Concurrent 容器 Executor（内部不调 LLM，只做 fan-out/fan-in 聚合） */
export class ConcurrentExecutor implements Executor {
  readonly id: string
  cache: import('@shared/types').OrchMessage[] = []
  private readonly participantIds: string[]
  private readonly aggregatorId: string

  constructor(id: string, participantIds: string[], aggregatorId: string) {
    this.id = id
    this.participantIds = participantIds
    this.aggregatorId = aggregatorId
  }

  async *handle(
    req: import('@shared/types').ExecutorRequest,
    ctx: WorkflowContext,
  ): AsyncIterable<StreamEvent> {
    if (!req.shouldRespond) return
    // fan-out：把输入消息发给所有 participant（下一 superstep 并发 deliver）
    const lastMsg = req.messages[req.messages.length - 1]
    if (!lastMsg) return
    for (const pid of this.participantIds) {
      await ctx.send_message(
        { ...lastMsg, author: this.id },
        pid,
      )
    }
    // aggregator 由 runner 在所有 participant 完成后触发（配 fan-in 边）
    // 骨架：aggregator 是普通 AgentExecutor，收齐各 participant 最后 assistant msg 拼合
    yield* [] // 无流式事件（fan-out 不产文本）
  }
}

export function buildConcurrent(
  node: GraphNode,
  participants: AgentExecutorOptions[],
  aggregator: AgentExecutorOptions,
  bctx: import('../models').BuilderContext,
): void {
  if (participants.length === 0) return

  // 注册所有 participant
  const participantIds: string[] = []
  for (const opts of participants) {
    const ex = new AgentExecutor(opts)
    participantIds.push(ex.id)
    bctx.addExecutor(ex)
  }

  // 注册 aggregator
  const aggEx = new AgentExecutor(aggregator)
  bctx.addExecutor(aggEx)

  // 注册 Concurrent 容器（作为 dispatcher + fan-in 协调）
  const container = new ConcurrentExecutor(node.id, participantIds, aggEx.id)
  bctx.addExecutor(container)

  // 边：each participant → aggregator（fan-out 由 handle 内部 send_message 实现，
  // 不再配 container→participant 边，避免 runner fan-out 重复投递）
  for (const pid of participantIds) {
    bctx.addEdge(pid, aggEx.id)
  }
}
