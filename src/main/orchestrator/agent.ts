import type {
  AgentConfig,
  AgentLimits,
  AgentRunCallbacks,
  AgentRunInput,
  LlmContentBlock,
  LlmDelta,
  LlmMessage,
  LlmResponse,
} from '@shared/types'
import { executeTool, getToolDefs } from '../tools/registry'
import { getClient } from '../llm/retry'
import type { LLMClientOptions } from '../llm/client'
import { isHandoffTool, parseHandoffTarget } from './patterns/handoff'
import { logger } from '../logger'

// —— 单 Agent 执行单元（§5.1.4 + §三之三 D + 铁律6）——
// Agent 管 context（messages/system/options），tool-use 循环借力 SDK
// （循环在 LLMClient.stream 内由 stop_reason 驱动，这里只编排多轮）。
// maxTokens 从 config.defaultOptions 取（铁律8）。

const DEFAULT_MAX_ITERATIONS = 10

export interface AgentDeps {
  /** LLM client 选项（apiKey/baseURL，从 vault + model config 解析） */
  llmOpts: LLMClientOptions
  /** 工具执行上下文（sessionId 等） */
  toolCtx?: { sessionId?: string; signal?: AbortSignal }
}

export class Agent {
  constructor(
    public config: AgentConfig,
    public deps: AgentDeps,
  ) {}

  /**
   * 多轮 tool-use 循环：
   * 1. 组装 messages + system + tools + maxTokens（从 defaultOptions）
   * 2. stream LLM，逐 delta 回调
   * 3. 若 stop_reason='tool_use' → 执行工具 → 追加 tool_result → 继续循环
   * 4. 直至 stop_reason 非 tool_use 或达上限
   */
  async run(
    input: AgentRunInput,
    callbacks: AgentRunCallbacks = {},
    limits: AgentLimits = {},
  ): Promise<{ messages: LlmMessage[]; finalText: string }> {
    const maxIter = limits.maxIterations ?? DEFAULT_MAX_ITERATIONS
    let functionCallCount = 0
    const messages = [...input.messages]
    const tools = this.resolveTools()
    const client = getClient(this.config.modelId, this.deps.llmOpts)

    let finalText = ''

    for (let iter = 0; iter < maxIter; iter++) {
      if (input.signal?.aborted) {
        throw input.signal.reason ?? new Error('aborted')
      }

      const response = await client.stream({
        model: this.config.modelId,
        system: this.config.instructions,
        messages,
        tools: tools.length ? tools : undefined,
        maxTokens: this.config.defaultOptions.maxTokens, // 铁律8
        temperature: this.config.defaultOptions.temperature,
        signal: input.signal,
        onDelta: (delta: LlmDelta) => this.emitDelta(delta, callbacks),
        onRetry: (info) => callbacks.onRetry?.(info),
      })

      // 把 assistant 产出追加到 messages（下一轮 tool_result 要配对）
      messages.push({ role: 'assistant', content: response.content })

      // 聚合文本
      const text = extractText(response.content)
      if (text) finalText = text

      // stop_reason 非 tool_use → 终止
      if (response.stopReason !== 'tool_use') break

      // 执行所有 tool_use 块，追加 tool_result
      const toolUses = response.content.filter(
        (b): b is Extract<LlmContentBlock, { type: 'tool_use' }> =>
          b.type === 'tool_use',
      )

      if (limits.maxFunctionCalls && functionCallCount + toolUses.length > limits.maxFunctionCalls) {
        logger.warn(`[agent:${this.config.name}] 达 maxFunctionCalls，停止工具调用`)
        break
      }

      const toolResults: LlmContentBlock[] = []
      let handoffTarget: string | null = null
      for (const tu of toolUses) {
        functionCallCount++
        callbacks.onToolCall?.(tu.name, tu.input)

        // —— Handoff 短路（铁律12）：handoff_to_X tool 不真执行 ——
        // 注入合成 result + 标记 target + 终止循环（MiddlewareTermination 等价）
        if (isHandoffTool(tu.name)) {
          handoffTarget = parseHandoffTarget(tu.name)
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify({ handoff_to: handoffTarget }),
            is_error: false,
          })
          continue // 不 executeTool，短路
        }

        const result = await executeTool(
          tu.name,
          tu.input,
          tu.id,
          {
            sessionId: this.deps.toolCtx?.sessionId,
            signal: input.signal,
          },
        )
        callbacks.onToolResult?.(tu.name, result.content)
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: result.content,
          is_error: result.isError,
        })
      }

      messages.push({ role: 'user', content: toolResults })

      // —— Handoff 短路（铁律12）：handoff_to_X 触发后终止循环 ——
      // finalText 设为合成 result JSON，供 HandoffExecutor 解析路由
      if (handoffTarget) {
        finalText = JSON.stringify({ handoff_to: handoffTarget })
        break
      }
    }

    return { messages, finalText }
  }

  private resolveTools() {
    if (this.config.tools?.length) return this.config.tools
    if (this.config.toolNames?.length) return getToolDefs(this.config.toolNames)
    return []
  }

  private emitDelta(delta: LlmDelta, cb: AgentRunCallbacks): void {
    if (delta.type === 'text') cb.onText?.(delta.text)
  }
}

function extractText(blocks: LlmContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<LlmContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

void logger
export type { LlmResponse }
