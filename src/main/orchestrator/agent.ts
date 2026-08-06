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
//
// maxIterations 是防死循环保险丝，不是「任务做完」信号：
// 触顶且末轮仍是 tool_use 时，强制再打一轮无工具收尾，避免半截话当终局。

/** 工具循环默认上限（原 10 对多步 shell/检索任务偏紧） */
export const DEFAULT_MAX_ITERATIONS = 32

/**
 * 运行时上下文注入（system 末尾）：当前本地时间 + 时区。
 * 「最近24小时/最近一周」这类时间相对意图，agent 必须知道"现在"才能判断内容过期。
 */
export function injectRuntimeContext(instructions: string): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  const offsetMin = -now.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  const tz = `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${pad(abs % 60)}` : ''}`
  return `${instructions}\n\n<runtime_context>\n当前时间：${local}（${tz}）\n</runtime_context>`
}

export interface AgentDeps {
  /** LLM client 选项（apiKey/baseURL，从 vault + model config 解析） */
  llmOpts: LLMClientOptions
  /** 工具执行上下文（sessionId / 创建提案回调 / HITL 提问桥 / 工具审批桥等） */
  toolCtx?: {
    sessionId?: string
    signal?: AbortSignal
    onPropose?: (draft: import('@shared/types').CreateDraft) => void
    onAskUser?: (req: { question: string; context?: string }) => Promise<string>
    onApprove?: (req: { toolName: string; args: unknown }) => Promise<{ approved: boolean; reason?: string }>
  }
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
   * 4. 直至 stop_reason 非 tool_use；若触顶仍停在 tool_result 后 → 强制无工具收尾轮
   */
  async run(
    input: AgentRunInput,
    callbacks: AgentRunCallbacks = {},
    limits: AgentLimits = {},
  ): Promise<{
    messages: LlmMessage[]
    finalText: string
    finalThinking: string
    /** 是否因 maxIterations 触顶而强制收尾（非正常 end_turn） */
    hitIterationLimit: boolean
  }> {
    const maxIter = limits.maxIterations ?? DEFAULT_MAX_ITERATIONS
    let functionCallCount = 0
    const messages = [...input.messages]
    const tools = this.resolveTools()
    const client = getClient(this.config.modelId, this.deps.llmOpts)
    const system = injectRuntimeContext(this.config.instructions)

    let finalText = ''
    let finalThinking = ''
    let hitIterationLimit = false

    for (let iter = 0; iter < maxIter; iter++) {
      if (input.signal?.aborted) {
        throw input.signal.reason ?? new Error('aborted')
      }

      logger.debug('[agent] thinking config:', this.config.thinking)
      const response = await client.stream({
        model: this.config.modelId,
        system,
        messages,
        tools: tools.length ? tools : undefined,
        maxTokens: this.config.defaultOptions.maxTokens, // 铁律8
        temperature: this.config.defaultOptions.temperature,
        thinking: this.config.thinking,
        signal: input.signal,
        onDelta: (delta: LlmDelta) => this.emitDelta(delta, callbacks),
        onRetry: (info) => callbacks.onRetry?.(info),
      })

      // 把 assistant 产出追加到 messages（下一轮 tool_result 要配对）
      messages.push({ role: 'assistant', content: response.content })

      // 聚合文本 + thinking
      const text = extractText(response.content)
      if (text) finalText = text
      const thinkingText = extractThinking(response.content)
      if (thinkingText) finalThinking = thinkingText

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
            onPropose: this.deps.toolCtx?.onPropose,
            onAskUser: this.deps.toolCtx?.onAskUser,
            onApprove: this.deps.toolCtx?.onApprove,
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

      // 本轮是最后一轮迭代槽且刚执行完工具 → 循环将结束，标记需收尾
      if (iter === maxIter - 1) {
        hitIterationLimit = true
      }
    }

    // 触顶停在 tool_result 之后：强制无工具收尾，让模型基于已有结果给最终答复
    if (hitIterationLimit && needsToolResultFinalization(messages) && !input.signal?.aborted) {
      logger.warn(
        `[agent:${this.config.name}] 达 maxIterations=${maxIter}，强制无工具收尾轮`,
      )
      const response = await client.stream({
        model: this.config.modelId,
        system,
        messages,
        tools: undefined, // 禁止再调工具
        maxTokens: this.config.defaultOptions.maxTokens,
        temperature: this.config.defaultOptions.temperature,
        thinking: this.config.thinking,
        signal: input.signal,
        onDelta: (delta: LlmDelta) => this.emitDelta(delta, callbacks),
        onRetry: (info) => callbacks.onRetry?.(info),
      })
      messages.push({ role: 'assistant', content: response.content })
      const text = extractText(response.content)
      if (text) finalText = text
      const thinkingText = extractThinking(response.content)
      if (thinkingText) finalThinking = thinkingText
    }

    return { messages, finalText, finalThinking, hitIterationLimit }
  }

  private resolveTools() {
    if (this.config.tools?.length) return this.config.tools
    if (this.config.toolNames?.length) return getToolDefs(this.config.toolNames)
    return []
  }

  private emitDelta(delta: LlmDelta, cb: AgentRunCallbacks): void {
    if (delta.type === 'text') cb.onText?.(delta.text)
    else if (delta.type === 'thinking') cb.onThinking?.(delta.text)
  }
}

function extractText(blocks: LlmContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<LlmContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

function extractThinking(blocks: LlmContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<LlmContentBlock, { type: 'thinking' }> => b.type === 'thinking')
    .map((b) => b.thinking)
    .join('')
}

/** 末条是否为 tool_result user 消息（触顶后尚无最终 assistant 答复） */
function needsToolResultFinalization(messages: LlmMessage[]): boolean {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'user' || typeof last.content === 'string') return false
  return last.content.some((b) => b.type === 'tool_result')
}

export type { LlmResponse }
