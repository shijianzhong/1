import type { GraphNode } from '@shared/types'
import type { BuilderContext } from '../models'
import type { AgentExecutorOptions } from './agent'
import { AgentExecutor } from './agent'

// —— Sequential pattern（§三 D + §三之三 G）——
// 线性边 A→B→C，上游 full_conversation extend 到下游 cache；
// 下游无 tool 时 strip_tool_blocks_filter 剥上游 tool 块（治 2013）；
// 末条 assistant 非自己时追加 user 唤醒指令（wake_on_upstream 治复述）。
//
// builder 职责：把 participants 按顺序连成线性边，每个包成 AgentExecutor。
// 实际的 strip/wake 逻辑在 AgentExecutor.assembleMessages 里。

export function buildSequential(
  node: GraphNode,
  participants: AgentExecutorOptions[],
  bctx: BuilderContext,
): void {
  void node
  if (participants.length === 0) return

  // 每个 participant 包成 AgentExecutor，注册
  const executors: AgentExecutor[] = []
  for (const opts of participants) {
    const ex = new AgentExecutor(opts)
    executors.push(ex)
    bctx.addExecutor(ex)
  }

  // 配线性边 A→B→C
  for (let i = 0; i < executors.length - 1; i++) {
    bctx.addEdge(executors[i].id, executors[i + 1].id)
  }
  // 注：outputFrom=last 的语义由 runner 在末位 executor 的 yield_output 实现
  // （AgentExecutor 默认每个都 yield_output，骨架先简化；中间节点的 output
  //  视 intermediate_output_from 决定是否 emit，后续 pattern 细化）
}
