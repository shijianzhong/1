import { describe, expect, it } from 'vitest'
import type { OrchMessage } from '@shared/types'
import { repairToolPairs, stripToolBlocksFilter } from './constraints'

// —— 编排约束单测（§K#1 铁律18 + §三之三 G）——

describe('repairToolPairs（铁律18）', () => {
  it('孤儿 tool_use（无配对 result）→ 降级为纯文本（删 toolUseId）', () => {
    const msgs: OrchMessage[] = [
      { role: 'user', content: '问题' },
      { role: 'assistant', author: 'A', content: '调用工具', toolUseId: 'tu_1' },
      // 无配对 tool_result
    ]
    const out = repairToolPairs(msgs)
    expect(out[1].toolUseId).toBeUndefined()
    expect(out[1].content).toBe('调用工具')
  })

  it('孤儿 tool_result（无配对 call）→ 降级为普通 user（剥 isFunctionResult/toolUseId）', () => {
    const msgs: OrchMessage[] = [
      { role: 'user', content: '问题' },
      { role: 'user', content: '结果', isFunctionResult: true, toolUseId: 'tu_1' },
    ]
    const out = repairToolPairs(msgs)
    expect(out[1].toolUseId).toBeUndefined()
    expect(out[1].isFunctionResult).toBeUndefined()
    expect(out[1].content).toBe('结果')
  })

  it('配对完整（tool_use + tool_result）→ 保留原样', () => {
    const msgs: OrchMessage[] = [
      { role: 'user', content: '问题' },
      { role: 'assistant', author: 'A', content: '调用工具', toolUseId: 'tu_1' },
      { role: 'user', content: '结果', isFunctionResult: true, toolUseId: 'tu_1' },
    ]
    const out = repairToolPairs(msgs)
    expect(out[1].toolUseId).toBe('tu_1')
    expect(out[2].isFunctionResult).toBe(true)
  })

  it('多组配对：只修孤儿，不影响正常对', () => {
    const msgs: OrchMessage[] = [
      { role: 'assistant', author: 'A', content: 'call1', toolUseId: 'tu_1' },
      { role: 'user', content: 'res1', isFunctionResult: true, toolUseId: 'tu_1' },
      { role: 'assistant', author: 'A', content: 'call2 孤儿', toolUseId: 'tu_2' },
    ]
    const out = repairToolPairs(msgs)
    expect(out[0].toolUseId).toBe('tu_1') // 正常对保留
    expect(out[1].isFunctionResult).toBe(true)
    expect(out[2].toolUseId).toBeUndefined() // 孤儿降级
  })

  it('孤儿降级后 content 为空 → 占位文本兜底（防空 text 块触发 Anthropic 新校验错）', () => {
    const msgs: OrchMessage[] = [
      // assistant 纯 tool_use（无文本）在编排消息模型里是 content: ''
      { role: 'assistant', author: 'A', content: '', toolUseId: 'tu_1' },
      { role: 'user', content: '  ', isFunctionResult: true, toolUseId: 'tu_2' },
    ]
    const out = repairToolPairs(msgs)
    expect(out[0].toolUseId).toBeUndefined()
    expect(out[0].content.trim().length).toBeGreaterThan(0)
    expect(out[1].isFunctionResult).toBeUndefined()
    expect(out[1].content.trim().length).toBeGreaterThan(0)
  })
})

describe('stripToolBlocksFilter', () => {
  it('剥 tool/function_result 块', () => {
    const msgs: OrchMessage[] = [
      { role: 'user', content: '问题' },
      { role: 'tool', content: 'tool_result' },
      { role: 'user', content: 'func_result', isFunctionResult: true },
      { role: 'assistant', author: 'A', content: '回答' },
    ]
    const out = stripToolBlocksFilter(msgs)
    expect(out.length).toBe(2)
    expect(out.some((m) => m.role === 'tool')).toBe(false)
    expect(out.some((m) => m.isFunctionResult)).toBe(false)
  })
})
