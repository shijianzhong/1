import { describe, expect, it } from 'vitest'
import { eventLabel, eventTone, factsOf, formatDuration, humanizeType } from './runEventsView'

describe('runEventsView', () => {
  it('eventLabel 返回已知类型的本地化标签', () => {
    expect(eventLabel('tool.completed', 'zh-CN')).toBe('工具执行完成')
    expect(eventLabel('tool.completed', 'en')).toBe('Tool completed')
  })

  it('eventLabel 对未知类型回退到人类可读形式', () => {
    expect(eventLabel('weird.event_kind', 'zh-CN')).toBe('Event Kind')
  })

  it('humanizeType 大写首字母并转换下划线', () => {
    expect(humanizeType('node.cache_truncated')).toBe('Cache Truncated')
  })

  it('eventTone 映射已知类型并兜底 neutral', () => {
    expect(eventTone('tool.failed')).toBe('danger')
    expect(eventTone('totally.unknown')).toBe('neutral')
  })

  it('factsOf 扁平化基本类型并跳过 __raw', () => {
    const facts = factsOf({ tool: 'shell', approved: true, ms: 12, __raw: 'x' })
    expect(facts).toEqual([
      { k: 'tool', v: 'shell' },
      { k: 'approved', v: 'true' },
      { k: 'ms', v: '12' },
    ])
  })

  it('factsOf 截断过长的值', () => {
    const facts = factsOf({ a: 'x'.repeat(200) })
    expect(facts[0].v.endsWith('…')).toBe(true)
    expect(facts[0].v.length).toBe(81)
  })

  it('formatDuration 覆盖各量级', () => {
    expect(formatDuration(500)).toBe('500ms')
    expect(formatDuration(1500)).toBe('1.5s')
    expect(formatDuration(65000)).toBe('1m5s')
    expect(formatDuration(null)).toBe('—')
  })
})
