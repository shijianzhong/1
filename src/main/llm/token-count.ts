import type { LlmMessage } from '@shared/types'

// —— token 近似计数（任务计划 Task 7）——
// 不引入 tiktoken 依赖：用经验公式（英文 ~4 chars/token，中文 ~1.5 chars/token）估算。
// 误差 10-20% 可接受，用于 L1 压缩触发与 runner cache 截断。

const CHARS_PER_TOKEN_EN = 4
const CHARS_PER_TOKEN_ZH = 1.5

/** 单条文本近似 token 数 */
export function approxTokenCount(text: string): number {
  let enChars = 0
  let zhChars = 0
  for (const c of text) {
    // 中日韩统一表意文字 + 平假名/片假名 + 全角标点
    if (/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uff00-\uffef]/.test(c)) zhChars++
    else enChars++
  }
  return Math.ceil(enChars / CHARS_PER_TOKEN_EN + zhChars / CHARS_PER_TOKEN_ZH)
}

/** 消息列表总 token 数（content 为 string 或 blocks） */
export function messagesTokenCount(messages: LlmMessage[]): number {
  let total = 0
  for (const m of messages) {
    if (typeof m.content === 'string') {
      total += approxTokenCount(m.content)
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === 'text') total += approxTokenCount(block.text)
        else if (block.type === 'tool_result') total += approxTokenCount(block.content)
        else if (block.type === 'tool_use') total += approxTokenCount(JSON.stringify(block.input))
      }
    }
  }
  return total
}
