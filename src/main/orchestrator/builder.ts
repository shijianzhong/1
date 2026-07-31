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
    addCondition(source, target, predicate) {
      const list = conditions.get(source) ?? []
      // 去重：同 source+target+predicate 不重复加
      if (!list.some((c) => c.target === target && c.predicate === predicate)) {
        list.push({ target, predicate })
      }
      conditions.set(source, list)
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
    // 条件边（GraphEdge.condition）→ conditions；无 condition → 普通边
    if (e.condition && e.condition.trim()) {
      bctx.addCondition(e.source, e.target, e.condition.trim())
    } else {
      bctx.addEdge(e.source, e.target)
    }
  }

  // 起始 executor：容器节点的运行期入口解析。
  // - sequential 容器本身不注册 executor（仅画布分组，participant 经线性边串联），
  //   入口 = 第一个 participant；否则 runner 按容器 id 找 executor 会「未找到，跳过」→ 空输出。
  // - concurrent/groupchat 容器本身是注册的 executor（dispatcher/协调器），入口 = 容器 id。
  // - 普通 agent 节点：入口 = 自身 id。
  const startExecutor = resolveStartExecutor(graph)
  if (!startExecutor) {
    throw new Error('编排图无节点')
  }

  return { executors, startExecutor, edges, conditions, nodes }
}

/**
 * 解析运行期起始 executor id。
 *
 * 入口判定（显式优先，拓扑兜底）：
 * - 显式入口：顶层节点（无 data.parentId）中 data.isEntry === true 者，按 nodes 顺序取第一个。
 *   用户可在画布给 agent / 容器勾选「设为入口」，显式控制起点；
 * - 拓扑兜底：无显式入口时，顶层 + 无入边（不是任何 graph.edges[].target）者为候选，
 *   按 nodes 顺序取第一个；再无（异常图）回退 nodes[0]。
 *
 * 入口 executor 解析（容器可能是入口，递归到真实可执行节点）：
 * - sequential 容器：本身不注册 executor（participant 经线性边串联），入口 = 首个有效
 *   participant，递归（participant 可能是嵌套容器）；
 * - concurrent / groupchat / handoff 容器：本身是注册的 executor（dispatcher/协调器），
 *   入口 = 容器自身 id；
 * - agent：入口 = 自身 id。
 */
export function resolveStartExecutor(graph: WorkflowGraph): string {
  if (graph.nodes.length === 0) return ''

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]))
  // 入边目标集合（含条件边——condition 在同一条 edge 上）
  const hasIncoming = new Set(graph.edges.map((e) => e.target))
  const isTopLevel = (n: GraphNode) => !(n.data as { parentId?: string }).parentId
  const isEntry = (n: GraphNode) => (n.data as { isEntry?: boolean }).isEntry === true

  // 显式入口优先（仅顶层节点可设，防 participant 误设）；拓扑兜底；异常回退 nodes[0]
  const explicit = graph.nodes.filter((n) => isTopLevel(n) && isEntry(n))
  const topoCandidates = graph.nodes.filter((n) => isTopLevel(n) && !hasIncoming.has(n.id))
  const entry = explicit[0] ?? topoCandidates[0] ?? graph.nodes[0]

  // 递归解析到真实 executor（防容器嵌套/循环引用）
  const visited = new Set<string>()
  const resolve = (node: GraphNode): string => {
    if (visited.has(node.id)) return node.id // 循环引用兜底，返回当前 id 防死循环
    visited.add(node.id)
    if (node.type === 'sequential') {
      const participants = (node.data as { participants?: string[] }).participants ?? []
      for (const pid of participants) {
        const child = nodeById.get(pid)
        if (child) return resolve(child)
      }
      // sequential 无有效 participant → 找图中首个 agent 兜底
      return graph.nodes.find((n) => n.type === 'agent')?.id ?? node.id
    }
    // concurrent/groupchat/handoff 容器自身是 executor；agent 即自身
    return node.id
  }
  return resolve(entry)
}

/**
 * 按 id 查找图节点，兼容「图节点 id」与「角色库 id」两种形态。
 * 画布保存的参与者/聚合引用可能是角色源 id（sourceAgentId/agentId，如 agt_wechat_writing），
 * 而图节点 id 是画布生成的（如 agent_ms76ai3a）。先按节点 id 精确匹配，找不到回退按角色 id 匹配。
 */
function findAgentNode(graph: WorkflowGraph, idOrAgentId: string): GraphNode | undefined {
  const byId = graph.nodes.find((n) => n.id === idOrAgentId)
  if (byId) return byId
  return graph.nodes.find((n) => {
    const d = n.data as { sourceAgentId?: string; agentId?: string }
    return d.sourceAgentId === idOrAgentId || d.agentId === idOrAgentId
  })
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
      // aggregator 可能是图节点 id，也可能是角色库 id（sourceAgentId/agentId）——
      // 画布保存时 aggregator 引用了角色源 id（如 agt_wechat_writing），而图节点 id 是
      // 画布生成的（如 agent_ms76ai3a）。先按节点 id 找，找不到回退按角色 id 匹配（§兼容存量数据）。
      const aggregatorNode = findAgentNode(graph, aggregatorId)
      const aggregator = aggregatorNode ? deps.resolveAgent(aggregatorNode) : null
      if (participantOpts.length === 0 || !aggregator) {
        logger.warn(
          `[builder] concurrent ${node.id} 缺 participant 或 aggregator` +
            (aggregator ? '' : `（aggregator=${aggregatorId} 未匹配到图节点/角色）`),
        )
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
      // manager 模式：orchestrator agent 从图节点解析（data.orchestrator_agent 是节点 id）
      let orchestratorOpts: AgentExecutorOptions | null = null
      const orchNodeId = (node.data as { orchestrator_agent?: string }).orchestrator_agent
      if (orchNodeId) {
        const orchNode = graph.nodes.find((n) => n.id === orchNodeId)
        orchestratorOpts = orchNode ? deps.resolveAgent(orchNode) : null
      }
      buildGroupChat(node, participantOpts, bctx, orchestratorOpts)
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
