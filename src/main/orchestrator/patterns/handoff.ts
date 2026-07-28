import type {
  GraphNode,
  LlmToolDef,
  OrchMessage,
  StreamEvent,
  WorkflowContext,
} from '@shared/types'
import type { BuilderContext, Executor } from '../models'
import { AgentExecutor, type AgentExecutorOptions } from './agent'

// —— Handoff pattern（§三 D + §三之三 G + 铁律12）——
// 无谓词条件——"条件"就是 LLM 调 handoff_to_X 工具。
// 每个 participant 注入 handoff_to_<target> synthetic tool；LLM 调 handoff tool
// → middleware 注入合成 result → MiddlewareTermination 短路 tool 循环
// → 扫 function_result 解析 target → ctx.send_message(target)。

/** handoff 工具名前缀 */
export const HANDOFF_TOOL_PREFIX = 'handoff_to_'

/** 合成 handoff tool 定义 */
export function makeHandoffTool(targetId: string): LlmToolDef {
  return {
    name: `${HANDOFF_TOOL_PREFIX}${targetId}`,
    description: `把对话转交给 ${targetId}`,
    input_schema: { type: 'object', properties: {} },
  }
}

/** 判断 tool_use 是否 handoff 请求 */
export function isHandoffTool(toolName: string): boolean {
  return toolName.startsWith(HANDOFF_TOOL_PREFIX)
}

/** 从 handoff tool 名解析 target */
export function parseHandoffTarget(toolName: string): string | null {
  if (!isHandoffTool(toolName)) return null
  return toolName.slice(HANDOFF_TOOL_PREFIX.length)
}

/** MiddlewareTermination 信号（短路 tool-use 循环，铁律12） */
export const HANDOFF_TERMINATION = Symbol('handoff_termination')

/**
 * HandoffExecutor：容器节点，每个 participant clone 注入 handoff tools。
 * 收到 fan-in 的 handoff 路由消息后，转发给 target。
 */
export class HandoffExecutor implements Executor {
  readonly id: string
  cache: OrchMessage[] = []
  private readonly handoffs: Map<string, string[]> // source → targets

  constructor(id: string, handoffs: Array<{ source: string; targets: string[] }>) {
    this.id = id
    this.handoffs = new Map(handoffs.map((h) => [h.source, h.targets]))
  }

  async *handle(
    req: import('@shared/types').ExecutorRequest,
    ctx: WorkflowContext,
  ): AsyncIterable<StreamEvent> {
    if (!req.shouldRespond) return
    const lastMsg = req.messages[req.messages.length - 1]
    if (!lastMsg) return
    // lastMsg.content 形如 {"handoff_to": "target"}（合成 result 解析出的）
    const target = this.parseHandoffResult(lastMsg.content)
    if (target) {
      await ctx.add_event({ type: 'handoff', from: lastMsg.author ?? this.id, to: target })
      await ctx.send_message(lastMsg, target)
    }
    yield* []
  }

  private parseHandoffResult(content: string): string | null {
    try {
      const obj = JSON.parse(content) as { handoff_to?: string }
      return obj.handoff_to ?? null
    } catch {
      return null
    }
  }
}

/** builder：每个 participant 注入 handoff_to_<target> synthetic tool + 容器 */
export function buildHandoff(
  node: GraphNode,
  participants: AgentExecutorOptions[],
  bctx: BuilderContext,
): void {
  const data = node.data as {
    handoffs?: Array<{ source: string; targets: string[] }>
    start_agent?: string
  }
  const handoffs = data.handoffs ?? []

  // 给每个 participant 注入 handoff tools（clone config）
  for (const opts of participants) {
    const targets = handoffs
      .filter((h) => h.source === opts.config.name)
      .flatMap((h) => h.targets)
    const handoffTools = targets.map(makeHandoffTool)
    const cloned: AgentExecutorOptions = {
      ...opts,
      config: {
        ...opts.config,
        tools: [...(opts.config.tools ?? []), ...handoffTools],
      },
    }
    bctx.addExecutor(new AgentExecutor(cloned))
    // participant → handoff 容器（fan-in，handoff result 回容器路由）
    bctx.addEdge(opts.config.name, node.id)
  }

  const container = new HandoffExecutor(node.id, handoffs)
  bctx.addExecutor(container)
}
