import { describe, expect, it } from 'vitest'
import type { LlmDelta } from '@shared/types'
import { handleStreamEvent } from './client'
import { ThinkingTagParser } from './thinking-tag-parser'

// —— 流式 tool_use ID 一致性（content_block index → tool_use id 映射）——
// 修复前：start 发 b.id（toolu_*），delta/stop 发 event.index.toString()（"0"/"1"），
// 消费端无法关联；且 text 块也会发伪 tool_use_stop。

type RawEvent = Parameters<typeof handleStreamEvent>[0]

function collector() {
  const deltas: LlmDelta[] = []
  const tagParser = new ThinkingTagParser()
  const toolIds = new Map<number, string>()
  return {
    deltas,
    feed: (event: unknown) =>
      handleStreamEvent(event as RawEvent, (d) => deltas.push(d), tagParser, toolIds),
  }
}

describe('llm/client handleStreamEvent tool_use ID 一致性', () => {
  it('start/delta/stop 全程使用 Anthropic 分配的 tool_use id', () => {
    const c = collector()
    c.feed({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_abc', name: 'web_search', input: {} },
    })
    c.feed({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":' } })
    c.feed({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"AI"}' } })
    c.feed({ type: 'content_block_stop', index: 1 })
    expect(c.deltas).toEqual([
      { type: 'tool_use_start', id: 'toolu_abc', name: 'web_search' },
      { type: 'tool_use_delta', id: 'toolu_abc', partial_json: '{"q":' },
      { type: 'tool_use_delta', id: 'toolu_abc', partial_json: '"AI"}' },
      { type: 'tool_use_stop', id: 'toolu_abc' },
    ])
  })

  it('text 块不再发伪 tool_use_stop（只有登记过的 tool_use 块才发 stop）', () => {
    const c = collector()
    c.feed({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    c.feed({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } })
    c.feed({ type: 'content_block_stop', index: 0 })
    expect(c.deltas).toEqual([{ type: 'text', text: '你好' }])
  })

  it('多个 tool_use 块交错：各自 index 映射各自的 id', () => {
    const c = collector()
    c.feed({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'a', input: {} } })
    c.feed({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_2', name: 'b', input: {} } })
    c.feed({ type: 'content_block_stop', index: 0 })
    c.feed({ type: 'content_block_stop', index: 1 })
    expect(c.deltas).toEqual([
      { type: 'tool_use_start', id: 'toolu_1', name: 'a' },
      { type: 'tool_use_start', id: 'toolu_2', name: 'b' },
      { type: 'tool_use_stop', id: 'toolu_1' },
      { type: 'tool_use_stop', id: 'toolu_2' },
    ])
  })
})
