import { describe, it, expect } from 'vitest'
import type { LlmDelta } from '@shared/types'
import { ThinkingTagParser } from './thinking-tag-parser'

describe('ThinkingTagParser', () => {
  it('普通文本无标签：全部作为 text 输出', () => {
    const parser = new ThinkingTagParser()
    const deltas: LlmDelta[] = [...parser.feed('你好世界'), ...parser.flush()]
    expect(deltas).toEqual([{ type: 'text', text: '你好世界' }])
  })

  it('配对 think 标签：标签内为 thinking，标签外为 text', () => {
    const parser = new ThinkingTagParser()
    const deltas: LlmDelta[] = [
      ...parser.feed('前面文本\u003Cthink\u003E思考过程\u003C/think\u003E后面文本'),
      ...parser.flush(),
    ]
    expect(deltas).toEqual([
      { type: 'text', text: '前面文本' },
      { type: 'thinking', text: '思考过程' },
      { type: 'text', text: '后面文本' },
    ])
  })

  it('配对 thinking 标签', () => {
    const parser = new ThinkingTagParser()
    const deltas: LlmDelta[] = [
      ...parser.feed('A\u003Cthinking\u003EB\u003C/thinking\u003EC'),
      ...parser.flush(),
    ]
    expect(deltas).toEqual([
      { type: 'text', text: 'A' },
      { type: 'thinking', text: 'B' },
      { type: 'text', text: 'C' },
    ])
  })

  it('配对 adia 标签', () => {
    const parser = new ThinkingTagParser()
    const deltas: LlmDelta[] = [
      ...parser.feed('A\u003Cadia\u003EB\u003C/adia\u003EC'),
      ...parser.flush(),
    ]
    expect(deltas).toEqual([
      { type: 'text', text: 'A' },
      { type: 'thinking', text: 'B' },
      { type: 'text', text: 'C' },
    ])
  })

  // —— 代理兼容：孤立闭标签（开标签被中转代理剥离）——
  it('孤立闭标签：闭标签前内容作为 thinking，之后作为 text', () => {
    const parser = new ThinkingTagParser()
    const deltas: LlmDelta[] = [
      ...parser.feed('思考过程内容\u003C/think\u003E实际回答'),
      ...parser.flush(),
    ]
    expect(deltas).toEqual([
      { type: 'thinking', text: '思考过程内容' },
      { type: 'text', text: '实际回答' },
    ])
  })

  it('孤立闭标签（无后文）：闭标签前内容作为 thinking', () => {
    const parser = new ThinkingTagParser()
    const deltas: LlmDelta[] = [
      ...parser.feed('只有思考\u003C/think\u003E'),
      ...parser.flush(),
    ]
    expect(deltas).toEqual([
      { type: 'thinking', text: '只有思考' },
    ])
  })

  it('纯 thinking（无闭标签）：flush 时作为 thinking 输出', () => {
    const parser = new ThinkingTagParser()
    const deltas: LlmDelta[] = [
      ...parser.feed('\u003Cthink\u003E只有思考没有结束'),
      ...parser.flush(),
    ]
    expect(deltas).toEqual([
      { type: 'thinking', text: '只有思考没有结束' },
    ])
  })

  // —— 跨 delta 分片测试 ——
  it('标签跨 delta 分片：正确拼接', () => {
    const parser = new ThinkingTagParser()
    const deltas: LlmDelta[] = []
    for (const chunk of ['hello ', '\u003Cthi', 'nking\u003E', 'reasoning', '\u003C/thi', 'nking\u003E', ' world']) {
      deltas.push(...parser.feed(chunk))
    }
    deltas.push(...parser.flush())
    expect(deltas).toEqual([
      { type: 'text', text: 'hello ' },
      { type: 'thinking', text: 'reasoning' },
      { type: 'text', text: ' world' },
    ])
  })

  it('孤立闭标签跨 delta 分片：正确拼接', () => {
    const parser = new ThinkingTagParser()
    const deltas: LlmDelta[] = []
    for (const chunk of ['think', 'ing content', '\u003C/thi', 'nk\u003E', 'answer']) {
      deltas.push(...parser.feed(chunk))
    }
    deltas.push(...parser.flush())
    expect(deltas).toEqual([
      { type: 'thinking', text: 'thinking content' },
      { type: 'text', text: 'answer' },
    ])
  })

  // —— 多段 thinking ——
  it('多段配对标签交替', () => {
    const parser = new ThinkingTagParser()
    const deltas: LlmDelta[] = [
      ...parser.feed('T1\u003Cthink\u003EP1\u003C/think\u003ET2\u003Cthink\u003EP2\u003C/think\u003ET3'),
      ...parser.flush(),
    ]
    expect(deltas).toEqual([
      { type: 'text', text: 'T1' },
      { type: 'thinking', text: 'P1' },
      { type: 'text', text: 'T2' },
      { type: 'thinking', text: 'P2' },
      { type: 'text', text: 'T3' },
    ])
  })

  // —— 模拟真实 DeepSeek 中转代理流 ——
  it('真实代理流：开标签被剥离，只有闭标签', () => {
    const parser = new ThinkingTagParser()
    const deltas: LlmDelta[] = []
    // 模拟代理返回的流：thinking 内容 + 闭标签 + 实际回答
    for (const chunk of [
      '我们被问到',
      '"1+1等于几',
      '？简短回答"。',
      '这是一个非常简单的问题',
      '。答案显然是2。',
      '但需要注意用户要求"简短回答"',
      '，所以直接回答2即可。\u003C/think\u003E',
      '2',
    ]) {
      deltas.push(...parser.feed(chunk))
    }
    deltas.push(...parser.flush())

    // 验证：thinking 部分被正确分离，text 只含 "2"
    const thinkingText = deltas
      .filter((d): d is Extract<LlmDelta, { type: 'thinking' }> => d.type === 'thinking')
      .map((d) => d.text)
      .join('')
    const textText = deltas
      .filter((d): d is Extract<LlmDelta, { type: 'text' }> => d.type === 'text')
      .map((d) => d.text)
      .join('')

    expect(thinkingText).toContain('我们被问到')
    expect(thinkingText).toContain('直接回答2即可。')
    expect(textText).toBe('2')
    // 闭标签不应出现在任何输出中
    expect(thinkingText).not.toContain('\u003C/think\u003E')
    expect(textText).not.toContain('\u003C/think\u003E')
  })
})
