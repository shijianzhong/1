import Anthropic from '@anthropic-ai/sdk'
import type { LlmDelta, LlmRequest, LlmResponse } from '@shared/types'
import { logger } from '../logger'

// —— Anthropic TS SDK 封装（§5.3 + §三之三 I + 铁律9）——
// 用 beta.messages.stream；system 抽顶层；role 映射 system/tool→user；
// content 映射 function_call↔tool_use、function_result↔tool_result。
// 重试由 retry.ts 包在本类 stream() 外层（铁律10）。

const BETAS = ['mcp-client-2025-04-04', 'code-execution-2025-08-25']

export interface LLMClientOptions {
  apiKey?: string
  /** 中转地址；空走官方 */
  baseURL?: string
  /** 自定义认证头名（如 x-api-key）；留空按 baseURL 推断：
   *  有 baseURL（中转）→ Authorization: Bearer <apiKey>（铁律9）
   *  无 baseURL（官方）→ SDK 默认 x-api-key */
  authHeader?: string
}

export class LLMClient {
  private readonly sdk: Anthropic

  constructor(opts: LLMClientOptions = {}) {
    const apiKey = opts.apiKey ?? 'unused'
    // 鉴权头：中转默认 Authorization Bearer（铁律9），官方走 SDK x-api-key
    let defaultHeaders: Record<string, string> | undefined
    if (opts.authHeader) {
      // 用户显式指定头名 + apiKey 作值
      defaultHeaders = { [opts.authHeader]: apiKey }
    } else if (opts.baseURL && opts.apiKey) {
      // 中转：Authorization: Bearer <apiKey>
      defaultHeaders = { Authorization: `Bearer ${apiKey}` }
    }
    this.sdk = new Anthropic({
      apiKey,
      baseURL: opts.baseURL,
      defaultHeaders,
    })
  }

  /**
   * 流式调用。重试层包在 stream 外层（铁律10：必须包真正发起请求的方法）。
   * @returns 最终响应（聚合 content + stopReason），供 agent 判定是否继续 tool-use 循环
   */
  async stream(req: LlmRequest): Promise<LlmResponse> {
    const { onDelta } = req
    const stream = await this.sdk.beta.messages.stream(
      {
        model: req.model,
        max_tokens: req.maxTokens, // 铁律8：从 defaultOptions 取，这里已解包
        temperature: req.temperature,
        system: req.system, // 抽顶层，不进 messages
        messages: req.messages.map(toAnthropicMessage),
        tools: req.tools as Anthropic.Beta.Messages.BetaTool[],
        betas: BETAS,
      },
      { signal: req.signal },
    )

    for await (const event of stream) {
      handleStreamEvent(event, onDelta)
    }

    const finalMessage = await stream.finalMessage()
    return {
      stopReason: finalMessage.stop_reason ?? null,
      content: fromAnthropicContent(finalMessage.content),
    }
  }
}

// —— role/content 映射（§三之三 I）——
// input 侧（我们→SDK）用 BetaContentBlockParam，含 tool_result（user 回传）
function toAnthropicMessage(msg: import('@shared/types').LlmMessage): {
  role: 'user' | 'assistant'
  content: string | Anthropic.Beta.Messages.BetaContentBlockParam[]
} {
  return {
    role: msg.role,
    content:
      typeof msg.content === 'string'
        ? msg.content
        : msg.content.map(toAnthropicBlock),
  }
}

function toAnthropicBlock(
  block: import('@shared/types').LlmContentBlock,
): Anthropic.Beta.Messages.BetaContentBlockParam {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      }
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: block.content,
        is_error: block.is_error ?? false,
      }
  }
}

// output 侧（SDK→我们）：模型产出只含 text/tool_use/thinking，无 tool_result
function fromAnthropicContent(
  content: Anthropic.Beta.Messages.BetaContentBlock[],
): import('@shared/types').LlmContentBlock[] {
  return content.map((b: Anthropic.Beta.Messages.BetaContentBlock) => {
    switch (b.type) {
      case 'text':
        return { type: 'text' as const, text: b.text }
      case 'tool_use':
        return {
          type: 'tool_use' as const,
          id: b.id,
          name: b.name,
          input: b.input,
        }
      default:
        // thinking/redacted_thinking/server_tool_use 等降级为 text
        return { type: 'text' as const, text: JSON.stringify(b) }
    }
  })
}

// —— 流式事件转 LlmDelta（§三之三 I：哪些 type 有输出）——
function handleStreamEvent(
  event: Anthropic.Beta.Messages.BetaRawMessageStreamEvent,
  onDelta: ((d: LlmDelta) => void) | undefined,
): void {
  if (!onDelta) return
  switch (event.type) {
    case 'content_block_start': {
      const b = event.content_block
      if (b.type === 'tool_use') {
        onDelta({ type: 'tool_use_start', id: b.id, name: b.name })
      }
      break
    }
    case 'content_block_delta': {
      const d = event.delta
      if (d.type === 'text_delta') {
        onDelta({ type: 'text', text: d.text })
      } else if (d.type === 'input_json_delta') {
        onDelta({
          type: 'tool_use_delta',
          id: event.index.toString(),
          partial_json: d.partial_json,
        })
      }
      break
    }
    case 'content_block_stop':
      onDelta({ type: 'tool_use_stop', id: event.index.toString() })
      break
    case 'message_delta':
      onDelta({
        type: 'message_stop',
        stop_reason: event.delta.stop_reason ?? null,
      })
      break
    default:
      break
  }
}

void logger // 预留日志（流式错误时用）
