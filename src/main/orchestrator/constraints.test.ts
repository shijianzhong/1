import { describe, expect, it } from 'vitest'
import type { OrchMessage } from '@shared/types'
import { repairToolPairs, stripForeignToolBlocks, stripToolBlocksFilter } from './constraints'

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

// —— stripForeignToolBlocks（铁律16 精神：用 author 剥上游 tool 块治跨 agent 2013）——
// Sequential 有工具的下游收到上游 full_conversation 转发：上游 tool_use/tool_result 属于
// 别的 agent 命名空间，重建为真 block 发出 → Anthropic 2013（tools 定义里没那个 id）。
// 剥掉降级为文本保语义，只留本 agent 自有的给 repairToolPairs 配对。
describe('stripForeignToolBlocks（铁律16 用 author 剥上游 tool 块）', () => {
  it('上游 agent 的 tool_use 块降级为文本（删 toolUseId/toolUseName，保 content）', () => {
    const msgs: OrchMessage[] = [
      { role: 'assistant', author: 'researcher', content: '调用 opencli', toolUseId: 'tu_1', toolUseName: 'opencli_run', toolUseInput: {} },
    ]
    const out = stripForeignToolBlocks(msgs, 'benchmark')
    expect(out[0].toolUseId).toBeUndefined()
    expect(out[0].toolUseName).toBeUndefined()
    expect(out[0].toolUseInput).toBeUndefined()
    expect(out[0].content).toBe('调用 opencli')
    expect(out[0].role).toBe('assistant')
    expect(out[0].author).toBe('researcher')
  })

  it('上游 agent 的 tool_result 块降级为普通 user（剥 isFunctionResult/toolUseId）', () => {
    const msgs: OrchMessage[] = [
      { role: 'user', author: 'researcher', content: 'opencli 返回结果正文', isFunctionResult: true, toolUseId: 'tu_1' },
    ]
    const out = stripForeignToolBlocks(msgs, 'benchmark')
    expect(out[0].isFunctionResult).toBeUndefined()
    expect(out[0].toolUseId).toBeUndefined()
    expect(out[0].content).toBe('opencli 返回结果正文')
    expect(out[0].role).toBe('user')
  })

  it('上游 role=tool 块降级为 user（与 stripToolBlocksFilter 一致行为但保留文本）', () => {
    const msgs: OrchMessage[] = [
      { role: 'tool', author: 'researcher', content: '工具输出' },
    ]
    const out = stripForeignToolBlocks(msgs, 'benchmark')
    expect(out[0].role).toBe('user')
    expect(out[0].content).toBe('工具输出')
  })

  it('本 agent 自有 tool 块保留原样（不剥）', () => {
    const msgs: OrchMessage[] = [
      { role: 'assistant', author: 'benchmark', content: '调 web_read', toolUseId: 'tu_2', toolUseName: 'web_read', toolUseInput: {} },
      { role: 'user', author: 'benchmark', content: '网页正文', isFunctionResult: true, toolUseId: 'tu_2' },
    ]
    const out = stripForeignToolBlocks(msgs, 'benchmark')
    expect(out[0].toolUseId).toBe('tu_2')
    expect(out[0].toolUseName).toBe('web_read')
    expect(out[1].isFunctionResult).toBe(true)
    expect(out[1].toolUseId).toBe('tu_2')
  })

  it('author 缺失的 tool 块保守保留（不误剥本 agent 的）', () => {
    // author 缺失=来源未知=保守当本 agent 自有。上游转发一定带 author，故缺失不可能是上游。
    const msgs: OrchMessage[] = [
      { role: 'user', content: '结果', isFunctionResult: true, toolUseId: 'tu_3' },
    ]
    const out = stripForeignToolBlocks(msgs, 'benchmark')
    expect(out[0].isFunctionResult).toBe(true)
    expect(out[0].toolUseId).toBe('tu_3')
  })

  it('非 tool 块（纯文本 user/assistant）不动', () => {
    const msgs: OrchMessage[] = [
      { role: 'user', author: undefined, content: '原始任务' },
      { role: 'assistant', author: 'researcher', content: '上游调研结论正文' },
    ]
    const out = stripForeignToolBlocks(msgs, 'benchmark')
    expect(out[0]).toEqual(msgs[0])
    expect(out[1]).toEqual(msgs[1])
  })

  it('上游 tool_use content 为空 → 占位文本兜底（防空 text 块触发 Anthropic 校验错）', () => {
    const msgs: OrchMessage[] = [
      { role: 'assistant', author: 'researcher', content: '', toolUseId: 'tu_1', toolUseName: 'opencli_run' },
    ]
    const out = stripForeignToolBlocks(msgs, 'benchmark')
    expect(out[0].toolUseId).toBeUndefined()
    expect(out[0].content.trim().length).toBeGreaterThan(0)
  })

  it('上游 tool_result content 为空 → 占位文本兜底', () => {
    const msgs: OrchMessage[] = [
      { role: 'user', author: 'researcher', content: '   ', isFunctionResult: true, toolUseId: 'tu_1' },
    ]
    const out = stripForeignToolBlocks(msgs, 'benchmark')
    expect(out[0].isFunctionResult).toBeUndefined()
    expect(out[0].content.trim().length).toBeGreaterThan(0)
  })
})
