import type { GraphNode, WorkflowGraph } from '@shared/types'
import type {
  BuilderContext,
  Executor,
  RuntimeWorkflow,
} from './models'
import { buildSequential } from './patterns/sequential'
import { buildConcurrent } from './patterns/concurrent'
import { buildGroupChat } from './patterns/groupchat'
import { buildHandoff } from './patterns/handoff'
import { buildMagentic } from './patterns/magentic'
import { AgentExecutor } from './patterns/agent'
import type { AgentExecutorOptions } from './patterns/agent'
import { logger } from '../logger'

// —— Builder（§5.1.2 + §三 C）——
// 把 ReactFlow JSON 图编译为可执行 RuntimeWorkflow。
// 自研而非依赖框架；环检测 + 按 type 分发到各 pattern builder；
// 无显式拓扑排序（由 Pregel superstep 隐式保证，§三之三 E）。

export interface BuildDeps {
  /** 从图节点解析 AgentExecutorOptions（含 config/llmOpts/toolCtx）
   *  节点 data 内联了 Agent 配置快照（instructions/skillIds/modelId 等），
   *  不再从全局 Agent 注册表查找。
   */
  resolveAgent: (node: GraphNode) => AgentExecutorOptions | null
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
      // 去重：避免 pattern builder + graph.edges 重复加同一条边导致 fan-out 重复投递
      if (!list.includes(target)) {
        list.push(target)
      }
      edges.set(source, list)
    },
    addSwitchCaseEdgeGroup(source, cases) {
      conditions.set(source, cases)
    },
  }

  // 节点索引
  for (const n of graph.nodes) nodes.set(n.id, n)

  // 按 type 分发（pattern builder 自动加 container↔participant 等内部边）
  for (const node of graph.nodes) {
    buildNode(node, graph, deps, bctx)
  }

  // 构建 concurrent 容器 → aggregator 映射（用于跳过视觉边）
  const containerAggregators = new Map<string, string>()
  for (const n of graph.nodes) {
    if (n.type === 'concurrent') {
      const agg = (n.data as { aggregator?: string })?.aggregator
      if (agg) containerAggregators.set(n.id, agg)
    }
  }

  // 容器子节点集合（序列化时 data.parentId 记录了画布 parent 关系）
  const childIds = new Set(
    graph.nodes
      .filter((n) => Boolean((n.data as { parentId?: string } | undefined)?.parentId))
      .map((n) => n.id),
  )

  // 补充显式边：graph.edges 中 pattern builder 未覆盖的跨节点连接
  // 跳过两类：
  // 1. concurrent container → aggregator 的边（画布视觉线，运行时已由
  //    buildConcurrent 内部加 participant → aggregator 边）
  // 2. 触及容器子节点的边——容器内部布线由 pattern builder 全权决定
  //    （sequential 链 / groupchat 广播 / handoff synthetic tool），
  //    子节点显式边叠加会造成双投递，甚至与 pattern 边组成 hasCycle
  //    检测不到的运行时环（hasCycle 只查 graph.edges）
  for (const e of graph.edges) {
    const skipAggregator = containerAggregators.get(e.source)
    if (skipAggregator === e.target) {
      continue // 视觉边，跳过
    }
    if (childIds.has(e.source) || childIds.has(e.target)) {
      logger.warn(
        `[builder] 跳过容器子节点显式边 ${e.source}→${e.target}（容器内部布线由 pattern 决定）`,
      )
      continue
    }
    bctx.addEdge(e.source, e.target)
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
    aggregator?: string
    output_from?: string
    intermediate_output_from?: string
  }

  switch (node.type) {
    case 'agent': {
      const opts = deps.resolveAgent(node)
      if (!opts) {
        logger.warn(`[builder] 无法解析 agent ${node.id}，跳过`)
        return
      }
      bctx.addExecutor(new AgentExecutor(opts))
      return
    }
    case 'sequential': {
      const participantNodes = (data.participants ?? [])
        .map((id) => graph.nodes.find((n) => n.id === id))
        .filter((n): n is GraphNode => !!n)
      const participantOpts = participantNodes
        .map((n) => deps.resolveAgent(n))
        .filter((o): o is AgentExecutorOptions => !!o)
      buildSequential(node, participantOpts, bctx)
      return
    }
    case 'concurrent': {
      const participantNodes = (data.participants ?? [])
        .map((id) => graph.nodes.find((n) => n.id === id))
        .filter((n): n is GraphNode => !!n)
      const participantOpts = participantNodes
        .map((n) => deps.resolveAgent(n))
        .filter((o): o is AgentExecutorOptions => !!o)
      // 优先从 data.aggregator 取聚合 Agent id；回退到 ${node.id}__aggregator 命名约定
      const aggregatorId = (data.aggregator as string) ?? `${node.id}__aggregator`
      const aggregatorNode = graph.nodes.find((n) => n.id === aggregatorId)
      const aggregator = aggregatorNode ? deps.resolveAgent(aggregatorNode) : null
      if (participantOpts.length === 0 || !aggregator) {
        logger.warn(`[builder] concurrent ${node.id} 缺 participant 或 aggregator`)
        return
      }
      buildConcurrent(node, participantOpts, aggregator, bctx)
      return
    }
    case 'groupchat': {
      const participantNodes = (data.participants ?? [])
        .map((id) => graph.nodes.find((n) => n.id === id))
        .filter((n): n is GraphNode => !!n)
      const participantOpts = participantNodes
        .map((n) => deps.resolveAgent(n))
        .filter((o): o is AgentExecutorOptions => !!o)
      if (participantOpts.length === 0) {
        logger.warn(`[builder] groupchat ${node.id} 缺 participant`)
        return
      }
      buildGroupChat(node, participantOpts, bctx)
      return
    }
    case 'handoff': {
      const participantNodes = (data.participants ?? [])
        .map((id) => graph.nodes.find((n) => n.id === id))
        .filter((n): n is GraphNode => !!n)
      const participantOpts = participantNodes
        .map((n) => deps.resolveAgent(n))
        .filter((o): o is AgentExecutorOptions => !!o)
      if (participantOpts.length === 0) {
        logger.warn(`[builder] handoff ${node.id} 缺 participant`)
        return
      }
      buildHandoff(node, participantOpts, bctx)
      return
    }
    case 'magentic':
      buildMagentic(node, bctx)
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
