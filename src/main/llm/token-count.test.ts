import { describe, expect, it } from 'vitest'
import { approxTokenCount, messagesTokenCount } from './token-count'

describe('token-count', () => {
  it('英文 4 chars/token', () => {
    expect(approxTokenCount('hello world')).toBe(3) // 11 chars / 4 ≈ 2.75 → 3
  })

  it('中文 1.5 chars/token', () => {
    expect(approxTokenCount('你好世界')).toBe(3) // 4 chars / 1.5 ≈ 2.67 → 3
  })

  it('中英混合', () => {
    // '你好ab cd'：2 中 + 5 英 = 2/1.5 + 5/4 = 1.33 + 1.25 = 2.58 → 3
    expect(approxTokenCount('你好ab cd')).toBe(3)
  })

  it('messagesTokenCount string content', () => {
    expect(messagesTokenCount([{ role: 'user', content: 'hi' }])).toBe(1)
  })

  it('messagesTokenCount blocks', () => {
    const msgs = [
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'hello world' }] },
    ]
    expect(messagesTokenCount(msgs)).toBe(3)
  })
})
