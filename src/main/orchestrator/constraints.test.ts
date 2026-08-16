import { describe, expect, it } from 'vitest'
import type { OrchMessage } from '@shared/types'
import { repairToolPairs, stripForeignToolBlocks, stripPseudoToolMarkers, stripToolBlocksFilter } from './constraints'

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

// —— stripPseudoToolMarkers（模型降级 function calling 伪工具标记泄漏）——
// MiniMax-M2.7 经中转网关收到 tools 定义却不返回真 tool_use block，改把各种
// 自创伪调用语法当文本吐 → 泄漏进用户可见正文。实测格式族：[tool:X]、
// [tool:="X"]、[tool:=...]、[tool name="..." ...]、[TOOL_CALL]...[/TOOL_CALL]。
// 按"结构信号"（冒号系 / name 属性系 / TOOL_CALL 块）匹配，保留合法 tool 词。
describe('stripPseudoToolMarkers（模型伪工具标记文本剥离）', () => {
  it('行级占位格式 [tool:X] 整行剥掉，保留前后正文', () => {
    const out = stripPseudoToolMarkers('正文\n[tool:web_search]\n下文')
    expect(out).toBe('正文\n下文')
  })

  it('冒号引号系 [tool:="X"] 句中删', () => {
    const out = stripPseudoToolMarkers('入库？ [tool:="sample_article_save"]')
    expect(out).toBe('入库？')
  })

  it('冒号引号系 [tool:="X"] 独行整行删', () => {
    const out = stripPseudoToolMarkers('入库？ [tool:="sample_article_save"]\n\n[tool:="sample_article_save"]')
    expect(out).toBe('入库？')
  })

  it('[TOOL_CALL]...[/TOOL_CALL] 块整段删（含大括号伪 JSON 参数）', () => {
    const out = stripPseudoToolMarkers('正文 [TOOL_CALL] {tool => "x", params => { --content "y" }} [/TOOL_CALL] 后文')
    expect(out).toBe('正文  后文')
  })

  it('多标签 name 属性块 [tool name="..." ...]...[/tool] 整段删', () => {
    const out = stripPseudoToolMarkers('前文\n[tool name="web_search" query="x"]结果[/tool]\n后文')
    expect(out).toBe('前文\n后文')
  })

  it('未闭单标签 [tool name="..." ...] 删', () => {
    const out = stripPseudoToolMarkers('[tool name="topic_detail" id="1"]')
    expect(out).toBe('')
  })

  it('保留正常正文与注释括号 [注]/[图1]', () => {
    const text = '[注]这是说明 [图1] 见下'
    expect(stripPseudoToolMarkers(text)).toBe(text)
  })

  it('不误删合法 tool 词（[tool reference] 无冒号/无 name= 结构信号）', () => {
    const text = '参考 [tool reference] 文档'
    expect(stripPseudoToolMarkers(text)).toBe(text)
  })

  it('不误删 tooling（词边界 tool 后跟 ing 非冒号）', () => {
    const text = '用 [tooling guide] 参考'
    expect(stripPseudoToolMarkers(text)).toBe(text)
  })

  it('空/空白输入原样返回不崩', () => {
    expect(stripPseudoToolMarkers('')).toBe('')
    expect(stripPseudoToolMarkers('   ')).toBe('')
  })

  it('删标记留下的 3+ 空行压成 2', () => {
    const out = stripPseudoToolMarkers('标题\n\n[tool:web_search]\n\n[tool:topic_trend]\n\n正文')
    expect(out).toBe('标题\n\n正文')
  })

  it('混合：标记全剥，标题/正文/注释括号保留', () => {
    const out = stripPseudoToolMarkers(
      '## 标题\n[tool:web_search]\n正文\n[tool name="t" q="y"]块[/tool]\n[注]说明',
    )
    expect(out).toBe('## 标题\n正文\n[注]说明')
  })

  // —— XML 标签系伪工具调用（<minimax:tool_call>/<invoke>/<parameter>）——
  it('<minimax:tool_call>...</minimax:tool_call> 外层块整段删（吞内部 invoke/parameter）', () => {
    const out = stripPseudoToolMarkers(
      '前文 <minimax:tool_call><invoke name="web_search"><parameter name="query">x</parameter></invoke></minimax:tool_call> 后文',
    )
    expect(out).toBe('前文  后文')
  })

  it('<invoke name="...">...</invoke> 块整段删', () => {
    const out = stripPseudoToolMarkers(
      '正文 <invoke name="web_search"><parameter name="query">AI 融资 2026</parameter></invoke> 下文',
    )
    expect(out).toBe('正文  下文')
  })

  it('散落残留孤立 <parameter>/<invoke> 开闭合标签删', () => {
    const out = stripPseudoToolMarkers(
      '结语。</parameter> <parameter name="source">B站</parameter> </invoke> 这是什么',
    )
    // 标签全删，正文保留；行内多余空格不压缩（避免误伤代码缩进）
    expect(out).toBe('结语。   这是什么')
  })

  it('不误删合法 HTML <div>/<span>（非伪调用标签）', () => {
    const text = '用 <div class="box">包内容</div> 布局'
    expect(stripPseudoToolMarkers(text)).toBe(text)
  })

  it('纯空白行（只含空格/tab）归一 + 多余空行压成 2', () => {
    const out = stripPseudoToolMarkers(
      '正文\n\n   \n\t\n\n[tool:web_search]\n\n\n\n下文',
    )
    expect(out).toBe('正文\n\n下文')
  })
})
