import Anthropic from '@anthropic-ai/sdk'
import type { LlmDelta, LlmRequest, LlmResponse } from '@shared/types'
import { logger } from '../logger'
import { ThinkingTagParser } from './thinking-tag-parser'

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
    // 鉴权头：用户选 authorization → Bearer；选 x-api-key → x-api-key；
    // 留空按 baseURL 推断（中转 Bearer / 官方 SDK 默认 x-api-key）
    let defaultHeaders: Record<string, string> | undefined
    if (opts.authHeader === 'authorization' && opts.apiKey) {
      defaultHeaders = { Authorization: `Bearer ${apiKey}` }
    } else if (opts.authHeader === 'x-api-key' && opts.apiKey) {
      defaultHeaders = { 'x-api-key': apiKey }
    } else if (!opts.authHeader && opts.baseURL && opts.apiKey) {
      // 中转默认 Bearer（铁律9）
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
    // thinking：按供应商开关（req.thinking 由 home.ts 按 enableThinking 传入）
    const thinking = req.thinking
      ? req.thinking.type === 'enabled'
        ? { type: 'enabled' as const, budget_tokens: req.thinking.budgetTokens ?? 4096 }
        : req.thinking.type === 'adaptive'
          ? { type: 'adaptive' as const }
          : undefined
      : undefined
    logger.debug('[llm] stream 请求', { model: req.model, thinking: !!thinking, hasThinking: !!req.thinking })
    const stream = await this.sdk.beta.messages.stream(
      {
        model: req.model,
        max_tokens: req.maxTokens, // 铁律8：从 defaultOptions 取，这里已解包
        temperature: req.temperature,
        thinking,
        system: req.system, // 抽顶层，不进 messages
        messages: req.messages.map(toAnthropicMessage),
        tools: req.tools as Anthropic.Beta.Messages.BetaTool[],
        betas: BETAS,
      },
      { signal: req.signal },
    )

    // 标签解析器：中转代理不支持原生 thinking API 时，模型用 think 标签输出推理
    const tagParser = new ThinkingTagParser()
    for await (const event of stream) {
      handleStreamEvent(event, onDelta, tagParser)
    }

    const finalMessage = await stream.finalMessage()
    logger.debug('[llm] finalMessage content types', finalMessage.content.map((b: { type: string }) => b.type))
    // 清理最终 text 中的 thinking 标签（中转代理可能把标签留在 text block 里）
    const cleanedContent = fromAnthropicContent(finalMessage.content).map(stripThinkingTags)
    return {
      stopReason: finalMessage.stop_reason ?? null,
      content: cleanedContent,
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
    case 'thinking':
      // 传回 thinking block（含 signature，多轮 thinking 需要）
      return {
        type: 'thinking',
        thinking: block.thinking,
        signature: block.signature,
      } as Anthropic.Beta.Messages.BetaContentBlockParam
  }
}

// output 侧（SDK→我们）：模型产出只含 text/tool_use/thinking，无 tool_result
// thinking block 保留（传回 messages 供多轮 thinking 用），但 extractText 跳过
function fromAnthropicContent(
  content: Anthropic.Beta.Messages.BetaContentBlock[],
): import('@shared/types').LlmContentBlock[] {
  return content
    .filter((b) => b.type !== 'redacted_thinking')
    .map((b: Anthropic.Beta.Messages.BetaContentBlock) => {
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
        case 'thinking':
          // 保留 thinking block（含 signature，多轮 thinking 需要）
          return {
            type: 'thinking' as const,
            thinking: (b as { thinking: string }).thinking,
            signature: (b as { signature: string }).signature,
          }
        default:
          return { type: 'text' as const, text: JSON.stringify(b) }
      }
    })
}

// —— 流式事件转 LlmDelta（§三之三 I：哪些 type 有输出）——
// text_delta 经过 ThinkingTagParser：中转代理不支持原生 thinking API 时，
// 模型用 think 标签包推理过程，解析器把标签内文本转成 thinking delta。
function handleStreamEvent(
  event: Anthropic.Beta.Messages.BetaRawMessageStreamEvent,
  onDelta: ((d: LlmDelta) => void) | undefined,
  tagParser: ThinkingTagParser,
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
        // 中转可能把 thinking 内容混在 text_delta 里，用标签解析器分流
        const deltas = tagParser.feed(d.text)
        for (const delta of deltas) {
          onDelta(delta)
        }
      } else if (d.type === 'thinking_delta') {
        // 原生 thinking delta（官方 Anthropic API 走这条路径）
        onDelta({ type: 'thinking', text: (d as { thinking: string }).thinking })
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
      // flush 标签解析器残留 buffer
      for (const delta of tagParser.flush()) {
        onDelta(delta)
      }
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

/**
 * 从最终 text block 中清除 thinking 标签。
 * 中转代理可能把思考过程用标签包裹后留在 text block 里。
 * 流式阶段已通过 ThinkingTagParser 分流，但 finalMessage 的 content 是原始的。
 *
 * 代理兼容：某些中转会剥离开标签只留闭标签，
 * 此时 paired regex 匹配不到，需要第二遍清除孤立闭标签及其前文（thinking 内容）。
 */
function stripThinkingTags(block: import('@shared/types').LlmContentBlock): import('@shared/types').LlmContentBlock {
  if (block.type !== 'text') return block
  const tagPairs: Array<[string, string]> = [
    ['\u003Cthink\u003E', '\u003C/think\u003E'],
    ['\u003Cthinking\u003E', '\u003C/thinking\u003E'],
    ['\u003Cadia\u003E', '\u003C/adia\u003E'],
  ]
  let text = block.text
  // 第一遍：移除配对标签（开标签 + 内容 + 闭标签）
  for (const [open, close] of tagPairs) {
    const regex = new RegExp(
      open.replace(/[<>/]/g, (m) => '\\' + m) +
      '[\\s\\S]*?' +
      close.replace(/[<>/]/g, (m) => '\\' + m),
      'g',
    )
    text = text.replace(regex, '')
  }
  // 第二遍：移除孤立闭标签及其前文（代理剥离开标签后的残留）
  for (const [, close] of tagPairs) {
    const idx = text.indexOf(close)
    if (idx !== -1) {
      text = text.slice(idx + close.length)
    }
  }
  return { type: 'text' as const, text: text.trim() }
}
