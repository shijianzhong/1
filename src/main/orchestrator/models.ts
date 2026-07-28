import type {
  ExecutorRequest,
  GraphNode,
  OrchMessage,
  StreamEvent,
  WorkflowContext,
} from '@shared/types'

// —— 自研编排内核模型（§5.1.1 + §三 D）——
// Executor = workflow 节点；should_respond 双语义（铁律15）；
// builder 把 ReactFlow JSON 转成 RuntimeWorkflow，runner 用 Pregel superstep 调度。

/**
 * Executor：workflow 节点（§三 D 第一层抽象）。
 * 每种 pattern 的差异体现在 handle 的消息处理逻辑 + builder 配的边结构。
 */
export interface Executor {
  /** id == agent name == ReactFlow 节点 id（铁律20，1:1 映射，前端高亮用） */
  id: string
  /** 本节点消息缓存（broadcast 时 should_respond=false 仅 extend 此 cache） */
  cache: OrchMessage[]
  /**
   * 处理消息请求。
   * @returns 产出的 StreamEvent 流（async iterable，供 runner 转 onEvent）
   */
  handle(
    req: ExecutorRequest,
    ctx: WorkflowContext,
  ): AsyncIterable<StreamEvent>
}

/** RuntimeWorkflow：builder 产出，runner 消费 */
export interface RuntimeWorkflow {
  /** 所有 executor（id → executor） */
  executors: Map<string, Executor>
  /** 入口 executor id（初始消息投递目标） */
  startExecutor: string
  /** 边：source → targets（runner 投递用；条件边在 conditions 里判定） */
  edges: Map<string, string[]>
  /** 条件边：source → [{predicate, target}]（MVP 仅 contains: 谓词，§三之三 B） */
  conditions: Map<string, Array<{ predicate: string; target: string }>>
  /** 图节点配置（builder 配图时用） */
  nodes: Map<string, GraphNode>
}

/** 输入消息（runner 初始投递） */
export interface WorkflowInput {
  text: string
  sessionId?: string
}

/** builder 工厂函数签名（各 pattern 实现） */
export type PatternBuilder = (
  node: GraphNode,
  participants: Map<string, Executor>,
  ctx: BuilderContext,
) => void

export interface BuilderContext {
  /** 注册 executor 到 workflow */
  addExecutor(e: Executor): void
  /** 配普通边 */
  addEdge(source: string, target: string): void
  /** 配条件边（source 聚合 → 多个 case，§三 C） */
  addSwitchCaseEdgeGroup(
    source: string,
    cases: Array<{ predicate: string; target: string }>,
  ): void
}
