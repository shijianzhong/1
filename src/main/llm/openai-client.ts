import type {
  LlmContentBlock,
  LlmDelta,
  LlmMessage,
  LlmRequest,
  LlmResponse,
  LlmToolDef,
} from '@shared/types'
import { logger } from '../logger'
import type { LLMClientOptions, LLMProtocol } from './client'

// —— OpenAI 兼容协议适配器（P1#4）——
// 支持 OpenAI / DeepSeek / 其他 OpenAI-compatible API 的原生协议。
// 用 fetch + SSE 解析，不依赖任何 SDK。
// 与 Anthropic 适配器（client.ts）实现同一 LLMProtocol 接口，
// 由 retry.ts 的 getClient() 按 apiFormat 路由。

// —— OpenAI API 类型（仅用到的子集）——
interface OpenAIContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | OpenAIContentPart[] | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

interface OpenAIStreamDelta {
  role?: string
  content?: string | null
  tool_calls?: Array<{
    index: number
    id?: string
    type?: 'function'
    function?: { name?: string; arguments?: string }
  }>
  reasoning_content?: string
}

interface OpenAIStreamChunk {
  choices: Array<{
    delta: OpenAIStreamDelta
    finish_reason: string | null
  }>
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

export class OpenAILLMClient implements LLMProtocol {
  private readonly apiKey: string
  private readonly baseURL: string
  private readonly authHeader: string

  constructor(opts: LLMClientOptions = {}) {
    this.apiKey = opts.apiKey ?? 'unused'
    this.baseURL = (opts.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '')
    // OpenAI 协议默认 Authorization: Bearer
    this.authHeader = opts.authHeader ?? 'authorization'
  }

  async stream(req: LlmRequest): Promise<LlmResponse> {
    const url = `${this.baseURL}/chat/completions`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.authHeader === 'authorization') {
      headers['Authorization'] = `Bearer ${this.apiKey}`
    } else if (this.authHeader === 'x-api-key') {
      headers['x-api-key'] = this.apiKey
    }

    const body = this.buildRequestBody(req)
    logger.debug('[llm:openai] stream 请求', { model: req.model, url, hasTools: !!req.tools?.length })

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      const err = new Error(`OpenAI API ${response.status}: ${errText.slice(0, 500)}`)
      ;(err as Error & { status?: number }).status = response.status
      throw err
    }

    if (!response.body) {
      throw new Error('OpenAI API: no response body')
    }

    // —— SSE 流式解析 ——
    const contentBlocks: LlmContentBlock[] = []
    let textBuffer = ''
    // tool_calls 按 index 聚合。id 可能延迟到后续 chunk 才给（部分网关首帧无 id），
    // 此时若立即用合成 id 'call_'+index 发 start/delta，后续真 id 到来后改 existing.id
    // 再发 delta/stop，会导致 start/delta 与 stop 的 id 不一致 → 消费者配对断裂
    //（CODE_AUDIT 断言 1.2）。修：首帧无 id 时「挂起」——记 name/args 但不发 start/delta，
    // 等真 id 到了再补发 start + 累积 args；真 id 全程不到则用合成 id 兜底（聚合阶段发 stop）。
    // started 标记：是否已对消费者 emit 过 tool_use_start（保证 start→delta→stop 顺序）。
    const toolCallMap = new Map<
      number,
      { id: string; name: string; args: string; started: boolean }
    >()
    let stopReason: string | null = null
    let streamUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let sseBuffer = ''

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      sseBuffer += decoder.decode(value, { stream: true })

      // SSE 事件以 \n\n 分隔
      const events = sseBuffer.split('\n\n')
      sseBuffer = events.pop() ?? ''

      for (const event of events) {
        const lines = event.split('\n')
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') continue

          try {
            const chunk: OpenAIStreamChunk = JSON.parse(data)
            // usage-only chunk（最后一帧，choices 为空但含 usage）
            if (chunk.usage) {
              streamUsage = chunk.usage
            }
            const choice = chunk.choices?.[0]
            if (!choice) continue

            const delta = choice.delta

            // 文本增量
            if (delta.content) {
              textBuffer += delta.content
              req.onDelta?.({ type: 'text', text: delta.content })
            }

            // 推理内容（DeepSeek reasoning_content 等）
            if (delta.reasoning_content) {
              req.onDelta?.({ type: 'thinking', text: delta.reasoning_content })
            }

            // 工具调用增量
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const existing = toolCallMap.get(tc.index)
                if (!existing) {
                  // 新工具调用：先记 name/args，id 可能本帧就有也可能后续补。
                  const id = tc.id ?? `call_${tc.index}`
                  const name = tc.function?.name ?? ''
                  const args = tc.function?.arguments ?? ''
                  const started = !!tc.id // 有真 id 才立即发 start，否则挂起等真 id
                  toolCallMap.set(tc.index, { id, name, args, started })
                  if (started) {
                    req.onDelta?.({ type: 'tool_use_start', id, name })
                    if (args) {
                      req.onDelta?.({ type: 'tool_use_delta', id, partial_json: args })
                    }
                  }
                  // 无 id 时挂起：name/args 已进 entry，等后续 chunk 带 tc.id 时补发
                } else {
                  // 后续 chunk：补写 name（部分网关先 id 后 name）与 id（先 args 后 id）
                  if (tc.function?.name) existing.name = tc.function.name
                  const idJustArrived = !!tc.id && !existing.started
                  if (tc.id) existing.id = tc.id
                  // 增量参数
                  const argsChunk = tc.function?.arguments ?? ''
                  if (argsChunk) {
                    existing.args += argsChunk
                  }
                  // 若之前挂起、现在真 id 到了：补发 start + 全部累积 args（一次性）
                  if (idJustArrived) {
                    existing.started = true
                    req.onDelta?.({ type: 'tool_use_start', id: existing.id, name: existing.name })
                    if (existing.args) {
                      req.onDelta?.({ type: 'tool_use_delta', id: existing.id, partial_json: existing.args })
                    }
                  } else if (existing.started && argsChunk) {
                    // 已在发流：正常增量转发
                    req.onDelta?.({ type: 'tool_use_delta', id: existing.id, partial_json: argsChunk })
                  }
                  // 仍挂起（无 id 且未 started）：args 继续累积，不发 delta
                }
              }
            }

            if (choice.finish_reason) {
              stopReason = this.mapStopReason(choice.finish_reason)
            }
          } catch {
            // JSON 解析失败：跳过不完整的数据行
          }
        }
      }
    }

    // —— 聚合最终响应 ——
    if (textBuffer) {
      contentBlocks.push({ type: 'text', text: textBuffer })
    }

    for (const [, tc] of toolCallMap) {
      let input: unknown = {}
      try {
        input = tc.args ? JSON.parse(tc.args) : {}
      } catch {
        input = { _raw: tc.args }
      }
      // 兜底：真 id 全程未到（极端网关）→ 用合成 id 补发 start（保证 stop 有配对的 start）
      if (!tc.started) {
        req.onDelta?.({ type: 'tool_use_start', id: tc.id, name: tc.name })
        if (tc.args) {
          req.onDelta?.({ type: 'tool_use_delta', id: tc.id, partial_json: tc.args })
        }
      }
      req.onDelta?.({ type: 'tool_use_stop', id: tc.id })
      contentBlocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input,
      })
    }

    req.onDelta?.({
      type: 'message_stop',
      stop_reason: stopReason,
      usage: streamUsage
        ? {
            inputTokens: streamUsage.prompt_tokens,
            outputTokens: streamUsage.completion_tokens,
            totalTokens: streamUsage.total_tokens,
          }
        : undefined,
    })

    const toolNames = contentBlocks
      .filter((b): b is { type: 'tool_use'; id: string; name: string; input: unknown } => b.type === 'tool_use')
      .map((b) => b.name)
    const textLen = contentBlocks
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .reduce((n, b) => n + b.text.length, 0)

    logger.info(
      `[trace:cap] llm:openai.final model=${req.model} stop=${stopReason ?? 'null'} ` +
        `textLen=${textLen} tools=[${toolNames.join(',')}]`,
    )
    if (stopReason === 'max_tokens') {
      logger.warn(`[trace:cap] llm:openai.max_tokens model=${req.model} maxTokens=${req.maxTokens} textLen=${textLen}`)
    }

    return { stopReason, content: contentBlocks }
  }

  // —— 请求体构建 ——
  private buildRequestBody(req: LlmRequest): Record<string, unknown> {
    const messages: OpenAIMessage[] = []

    // system 放入 messages 首条（OpenAI 格式）
    if (req.system) {
      messages.push({ role: 'system', content: req.system })
    }

    // 转换消息
    for (const msg of req.messages) {
      messages.push(...this.toOpenAIMessages(msg))
    }

    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      max_tokens: req.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    }

    if (req.temperature !== undefined) {
      body.temperature = req.temperature
    }

    if (req.tools?.length) {
      body.tools = req.tools.map(this.toOpenAITool)
    }

    return body
  }

  /** LlmMessage → OpenAI messages（tool_result 需拆成独立 tool 消息） */
  private toOpenAIMessages(msg: LlmMessage): OpenAIMessage[] {
    if (typeof msg.content === 'string') {
      return [{ role: msg.role, content: msg.content }]
    }

    const result: OpenAIMessage[] = []
    const assistantToolCalls: OpenAIMessage['tool_calls'] = []
    let textParts: string[] = []
    const imageParts: OpenAIContentPart[] = []

    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          textParts.push(block.text)
          break
        case 'tool_use':
          assistantToolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          })
          break
        case 'tool_result':
          // tool_result 必须作为独立的 role=tool 消息
          result.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: block.content,
          })
          break
        case 'thinking':
          // OpenAI 协议无 thinking block，跳过（推理内容不回传）
          break
        case 'image':
          imageParts.push({
            type: 'image_url',
            image_url: { url: `data:${block.mediaType};base64,${block.data}` },
          })
          break
      }
    }

    // assistant 消息（含 text + tool_calls）
    if (msg.role === 'assistant' && (textParts.length || assistantToolCalls.length)) {
      const assistantMsg: OpenAIMessage = { role: 'assistant' }
      if (textParts.length) {
        assistantMsg.content = textParts.join('')
      }
      if (assistantToolCalls.length) {
        assistantMsg.tool_calls = assistantToolCalls
      }
      result.unshift(assistantMsg)
    } else if (textParts.length || imageParts.length) {
      // 有图片时用 content array 格式（OpenAI multimodal）
      if (imageParts.length) {
        const parts: OpenAIContentPart[] = []
        if (textParts.length) parts.push({ type: 'text', text: textParts.join('') })
        parts.push(...imageParts)
        result.unshift({ role: msg.role, content: parts })
      } else {
        result.unshift({ role: msg.role, content: textParts.join('') })
      }
    }

    return result
  }

  private toOpenAITool(tool: LlmToolDef): OpenAITool {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }
  }

  /** OpenAI finish_reason → 内部 stopReason（与 Anthropic 对齐） */
  private mapStopReason(reason: string): string {
    switch (reason) {
      case 'stop':
        return 'end_turn'
      case 'length':
        return 'max_tokens'
      case 'tool_calls':
        return 'tool_use'
      case 'content_filter':
        return 'content_filter'
      default:
        return reason
    }
  }
}
