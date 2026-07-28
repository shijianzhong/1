import { describe, expect, it } from 'vitest'
import type { OrchMessage } from '@shared/types'
import {
  applyFairnessPatch,
  dedupMessages,
  extractManagerOutput,
  stripToolBlocks,
} from './groupchat'

// —— GroupChat 四 patch 单测（§10.1 + §三之三 G + 铁律13）——
// 纯函数测试；broadcast/round_robin 运行时走 E2E。

describe('GroupChat 四 patch', () => {
  it('dedup_patch：按 role+author+content 去重', () => {
    const msgs: OrchMessage[] = [
      { role: 'user', author: 'A', content: 'hi' },
      { role: 'assistant', author: 'B', content: 'hello' },
      { role: 'user', author: 'A', content: 'hi' }, // 重复
      { role: 'assistant', author: 'B', content: 'hello' }, // 重复
    ]
    const out = dedupMessages(msgs)
    expect(out.length).toBe(2)
  })

  it('dedup_patch：不同 author 不去重', () => {
    const msgs: OrchMessage[] = [
      { role: 'assistant', author: 'A', content: 'hi' },
      { role: 'assistant', author: 'B', content: 'hi' },
    ]
    expect(dedupMessages(msgs).length).toBe(2)
  })

  it('stripToolBlocks：剥 tool/function_result 块（铁律14 治 2013）', () => {
    const msgs: OrchMessage[] = [
      { role: 'user', content: '问题' },
      { role: 'tool', content: 'tool_result' },
      { role: 'user', content: 'func_result', isFunctionResult: true },
      { role: 'assistant', author: 'A', content: '回答' },
    ]
    const out = stripToolBlocks(msgs)
    expect(out.length).toBe(2)
    expect(out.some((m) => m.content === 'tool_result')).toBe(false)
    expect(out.some((m) => m.content === 'func_result')).toBe(false)
  })

  it('extractManagerOutput：直接 JSON', () => {
    const out = extractManagerOutput('{"terminate":true,"next_speaker":"A"}')
    expect(out).toEqual({ terminate: true, next_speaker: 'A' })
  })

  it('extractManagerOutput：剥 ```json 围栏', () => {
    const raw = '```json\n{"terminate":false,"next_speaker":"B"}\n```'
    const out = extractManagerOutput(raw) as { terminate: boolean }
    expect(out.terminate).toBe(false)
  })

  it('extractManagerOutput：正则兜底（无围栏无 JSON）', () => {
    const raw = '我认为 next_speaker 是 A {"terminate":true,"next_speaker":"A"} 结束'
    const out = extractManagerOutput(raw)
    expect(out).not.toBeNull()
  })

  it('extractManagerOutput：完全无法解析返回 null', () => {
    expect(extractManagerOutput('纯文本无 JSON')).toBeNull()
  })

  it('applyFairnessPatch：terminate=true 但有未发言者 → 强制 false', () => {
    const out = applyFairnessPatch(
      { terminate: true, next_speaker: 'A' },
      ['A', 'B', 'C'],
      new Set(['A']), // B C 未发言
    )
    expect(out.terminate).toBe(false)
    expect(out.next_speaker).toBe('B')
  })

  it('applyFairnessPatch：terminate=true 且全员已发言 → 保持 true', () => {
    const out = applyFairnessPatch(
      { terminate: true, next_speaker: 'A' },
      ['A', 'B'],
      new Set(['A', 'B']),
    )
    expect(out.terminate).toBe(true)
  })

  it('applyFairnessPatch：terminate=false 不干预', () => {
    const out = applyFairnessPatch(
      { terminate: false, next_speaker: 'A' },
      ['A', 'B'],
      new Set(['A']),
    )
    expect(out.terminate).toBe(false)
  })
})
