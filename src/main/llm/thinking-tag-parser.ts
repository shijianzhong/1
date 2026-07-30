import type { LlmDelta } from '@shared/types'

/**
 * 流式 thinking 标签解析器。
 *
 * 中转代理（如 DeepSeek）不支持 Anthropic 原生 thinking API，
 * 模型会把推理过程用文本标签包裹输出。
 *
 * 这个解析器在 text_delta 流中实时识别标签，把标签内文本转成 thinking delta。
 * 支持的标签：think, thinking, adia
 *
 * 工作原理：
 * - 维护一个状态机，跟踪当前是否在 thinking 标签内
 * - 遇到开标签 -> 切换到 thinking 模式，后续 text 走 thinking delta
 * - 遇到闭标签 -> 切换回 text 模式
 * - 跨 delta 的标签碎片自动拼接处理
 *
 * 代理兼容（重要）：
 * 某些中转代理会剥离开标签但保留闭标签，导致流里只有 `</think>` 没有 `<think>`。
 * 此时解析器在 text 模式下遇到孤立闭标签时，会把闭标签前的内容当作 thinking 输出，
 * 然后跳过闭标签继续在 text 模式。这样无论代理是否剥离开标签都能正确分流。
 */

const OPEN_TAGS = ['\u003Cthink\u003E', '\u003Cthinking\u003E', '\u003Cadia\u003E']
const CLOSE_TAGS = ['\u003C/think\u003E', '\u003C/thinking\u003E', '\u003C/adia\u003E']
const MAX_TAG_LEN = 20 // 最长标签长度，用于保留 buffer 尾部防截断
// 未见过任何标签时，使用更大的缓冲区。
// 原因：代理可能剥离开标签，导致整段 thinking 没有开标签只有闭标签。
// 如果缓冲区太小，thinking 内容会在闭标签到达前被当作 text 输出。
const MAX_UNCERTAIN_LEN = 200

export class ThinkingTagParser {
  private inThinking = false
  private buffer = ''
  private seenAnyTag = false

  /** 处理一段 text_delta，返回应发出的 delta 列表 */
  feed(text: string): LlmDelta[] {
    const deltas: LlmDelta[] = []
    this.buffer += text

    while (this.buffer.length > 0) {
      // 未见过标签时用更大的缓冲区，防止代理剥离开标签后 thinking 内容被误判为 text
      const retainLen = this.seenAnyTag ? MAX_TAG_LEN : MAX_UNCERTAIN_LEN
      if (this.inThinking) {
        // 在 thinking 区间内，查找闭标签
        const closeMatch = this.findTag(this.buffer, CLOSE_TAGS)
        if (closeMatch) {
          // 闭标签前的内容是 thinking
          const before = this.buffer.slice(0, closeMatch.index)
          if (before) deltas.push({ type: 'thinking', text: before })
          this.buffer = this.buffer.slice(closeMatch.index + closeMatch.tag.length)
          this.inThinking = false
          this.seenAnyTag = true
        } else {
          // 没找到闭标签，保留尾部防截断
          const safeLen = Math.max(0, this.buffer.length - retainLen)
          if (safeLen > 0) {
            deltas.push({ type: 'thinking', text: this.buffer.slice(0, safeLen) })
            this.buffer = this.buffer.slice(safeLen)
          }
          break
        }
      } else {
        // 在 text 区间内，查找开标签和孤立闭标签
        const openMatch = this.findTag(this.buffer, OPEN_TAGS)
        const closeMatch = this.findTag(this.buffer, CLOSE_TAGS)
        if (openMatch && (closeMatch === null || openMatch.index <= closeMatch.index)) {
          // 正常情况：找到开标签，开标签前的内容是 text
          const before = this.buffer.slice(0, openMatch.index)
          if (before) deltas.push({ type: 'text', text: before })
          this.buffer = this.buffer.slice(openMatch.index + openMatch.tag.length)
          this.inThinking = true
          this.seenAnyTag = true
        } else if (closeMatch) {
          // 代理兼容：孤立闭标签（开标签被代理剥离）
          // 闭标签前的内容实际上是 thinking
          const before = this.buffer.slice(0, closeMatch.index)
          if (before) deltas.push({ type: 'thinking', text: before })
          this.buffer = this.buffer.slice(closeMatch.index + closeMatch.tag.length)
          // 留在 text 模式（已经通过闭标签结束了 thinking）
          this.seenAnyTag = true
        } else {
          // 没找到任何标签，保留尾部防截断
          const safeLen = Math.max(0, this.buffer.length - retainLen)
          if (safeLen > 0) {
            deltas.push({ type: 'text', text: this.buffer.slice(0, safeLen) })
            this.buffer = this.buffer.slice(safeLen)
          }
          break
        }
      }
    }

    return deltas
  }

  /** 流结束时 flush 残留 buffer */
  flush(): LlmDelta[] {
    const deltas: LlmDelta[] = []
    if (this.buffer) {
      if (this.inThinking) {
        deltas.push({ type: 'thinking', text: this.buffer })
      } else {
        deltas.push({ type: 'text', text: this.buffer })
      }
      this.buffer = ''
    }
    return deltas
  }

  private findTag(text: string, tags: string[]): { index: number; tag: string } | null {
    let earliest: { index: number; tag: string } | null = null
    for (const tag of tags) {
      const idx = text.indexOf(tag)
      if (idx !== -1 && (earliest === null || idx < earliest.index)) {
        earliest = { index: idx, tag }
      }
    }
    return earliest
  }
}
