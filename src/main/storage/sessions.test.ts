import { describe, expect, it } from 'vitest'
import type { SessionMessage } from '@shared/types'
import { toLlmMessages } from './sessions'

// —— toLlmMessages 纯函数单测（§5.2.3 + 铁律21）——
// 锁定 SessionMessage[] → LlmMessage[] 映射的三种分支行为，防 home/orchestrate 共用后漂移。

function msg(partial: Partial<SessionMessage> & Pick<SessionMessage, 'role' | 'content'>): SessionMessage {
  return {
    id: 'm1',
    sessionId: 's1',
    createdAt: 1,
    ...partial,
  } as SessionMessage
}

describe('toLlmMessages', () => {
  it('structured 消息还原为 LlmContentBlock[] 且 role 原样保留', () => {
    const blocks = [{ type: 'text', text: 'hi' }]
    const rows = [msg({ role: 'assistant', content: JSON.stringify(blocks), meta: { structured: true } })]
    const out = toLlmMessages(rows)
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('assistant')
    expect(out[0].content).toEqual(blocks)
  })

  it("role 'tool' 重映射为 'user'（无论是否 structured）", () => {
    const structured = msg({ role: 'tool', content: JSON.stringify([{ type: 'tool_result', content: 'x' }]), meta: { structured: true } })
    const plain = msg({ role: 'tool', content: 'tool output' })
    const out = toLlmMessages([structured, plain])
    expect(out.every((m) => m.role === 'user')).toBe(true)
    expect((out[1].content as string)).toBe('tool output')
  })

  it('非 structured 普通消息原样取 content、role 不变', () => {
    const rows = [msg({ role: 'user', content: '你好' }), msg({ role: 'assistant', content: '在的' })]
    const out = toLlmMessages(rows)
    expect(out.map((m) => ({ role: m.role, content: m.content }))).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '在的' },
    ])
  })

  it('保持输入数组顺序', () => {
    const rows = [
      msg({ id: 'a', role: 'user', content: '1' }),
      msg({ id: 'b', role: 'assistant', content: '2' }),
      msg({ id: 'c', role: 'user', content: '3' }),
    ]
    const out = toLlmMessages(rows)
    expect(out.map((m) => (m.content as string))).toEqual(['1', '2', '3'])
  })

  it('空数组返回空', () => {
    expect(toLlmMessages([])).toEqual([])
  })
})
