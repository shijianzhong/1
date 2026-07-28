import type { GraphNode, WorkflowGraph } from '@shared/types'
import type {
  BuilderContext,
  Executor,
  RuntimeWorkflow,
} from './models'
import { buildSequential } from './patterns/sequential'
import { buildConcurrent } from './patterns/concurrent'
import { AgentExecutor } from './patterns/agent'
import type { AgentExecutorOptions } from './patterns/agent'
import { logger } from '../logger'

// —— Builder（§5.1.2 + §三 C）——
// 把 ReactFlow JSON 图编译为可执行 RuntimeWorkflow。
// 自研而非依赖框架；环检测 + 按 type 分发到各 pattern builder；
// 无显式拓扑排序（由 Pregel superstep 隐式保证，§三之三 E）。

export interface BuildDeps {
  /** 从节点 id 解析 AgentExecutorOptions（含 config/llmOpts/toolCtx） */
  resolveAgent: (nodeId: string) => AgentExecutorOptions | null
}

export function buildWorkflow(graph: WorkflowGraph, deps: BuildDeps): RuntimeWorkflow {
  const executors = new Map<string, Executor>()
  const edges = new Map<string, string[]>()
  const conditions = new Map<string, Array<{ predicate: string; target: string }>>()
  const nodes = new Map<string, GraphNode>()

  // 环检测
  if (hasCycle(graph)) {
    throw new Error('编排图存在环（不支持循环图）')
  }

  const bctx: BuilderContext = {
    addExecutor(e) {
      executors.set(e.id, e)
    },
    addEdge(source, target) {
      const list = edges.get(source) ?? []
      list.push(target)
      edges.set(source, list)
    },
    addSwitchCaseEdgeGroup(source, cases) {
      conditions.set(source, cases)
    },
  }

  // 节点索引
  for (const n of graph.nodes) nodes.set(n.id, n)

  // 按 type 分发
  for (const node of graph.nodes) {
    buildNode(node, graph, deps, bctx)
  }

  // 单节点（无边或仅一个节点）→ 直接作为 startExecutor
  const startExecutor = graph.nodes[0]?.id ?? ''
  if (!startExecutor) {
    throw new Error('编排图无节点')
  }

  return { executors, startExecutor, edges, conditions, nodes }
}

function buildNode(
  node: GraphNode,
  graph: WorkflowGraph,
  deps: BuildDeps,
  bctx: BuilderContext,
): void {
  const data = node.data as {
    participants?: string[]
    output_from?: string
    intermediate_output_from?: string
  }

  switch (node.type) {
    case 'agent': {
      const opts = deps.resolveAgent(node.id)
      if (!opts) {
        logger.warn(`[builder] 无法解析 agent ${node.id}，跳过`)
        return
      }
      bctx.addExecutor(new AgentExecutor(opts))
      return
    }
    case 'sequential': {
      const participantOpts = (data.participants ?? [])
        .map((id) => deps.resolveAgent(id))
        .filter((o): o is AgentExecutorOptions => !!o)
      buildSequential(node, participantOpts, bctx)
      return
    }
    case 'concurrent': {
      const participantOpts = (data.participants ?? [])
        .map((id) => deps.resolveAgent(id))
        .filter((o): o is AgentExecutorOptions => !!o)
      const aggregator = deps.resolveAgent(`${node.id}__aggregator`)
      if (participantOpts.length === 0 || !aggregator) {
        logger.warn(`[builder] concurrent ${node.id} 缺 participant 或 aggregator`)
        return
      }
      buildConcurrent(node, participantOpts, aggregator, bctx)
      return
    }
    case 'groupchat':
    case 'handoff':
      // 4b 阶段实现
      logger.warn(`[builder] ${node.type} 待 4b 阶段实现`)
      return
    case 'magentic':
      logger.warn(`[builder] magentic MVP 跳过，请用 groupchat+handoff 覆盖`)
      return
  }
}

/** 环检测（DFS 三色标记） */
function hasCycle(graph: WorkflowGraph): boolean {
  const adj = new Map<string, string[]>()
  for (const n of graph.nodes) adj.set(n.id, [])
  for (const e of graph.edges) {
    const list = adj.get(e.source) ?? []
    list.push(e.target)
    adj.set(e.source, list)
  }

  const color = new Map<string, number>() // 0=白 1=灰 2=黑
  for (const n of graph.nodes) color.set(n.id, 0)

  const visit = (id: string): boolean => {
    color.set(id, 1) // 灰
    for (const next of adj.get(id) ?? []) {
      const c = color.get(next) ?? 0
      if (c === 1) return true // 回边 → 环
      if (c === 0 && visit(next)) return true
    }
    color.set(id, 2) // 黑
    return false
  }

  for (const n of graph.nodes) {
    if (color.get(n.id) === 0 && visit(n.id)) return true
  }
  return false
}
