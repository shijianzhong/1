import { describe, expect, it } from 'vitest'
import {
  validateCron,
  nextOccurrence,
  previewNextRun,
  hasUpcomingOccurrence,
} from './cron'
import type { Schedule } from './types'

function makeSch(over: Partial<Schedule>): Schedule {
  return {
    id: 'sch_1',
    name: 't',
    enabled: true,
    cron: '0 9 * * *',
    timezone: 'UTC',
    action: { type: 'shell', command: 'echo' },
    notifyOnComplete: false,
    lastFiredAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  }
}

describe('shared/cron.validateCron', () => {
  it('接受合法 5 段表达式', () => {
    expect(validateCron('0 9 * * 1-5').valid).toBe(true)
    expect(validateCron('*/5 * * * *').valid).toBe(true)
  })
  it('拒绝空/段数不符/越界', () => {
    expect(validateCron('').valid).toBe(false)
    expect(validateCron('0 9 * *').valid).toBe(false) // 4 段
    expect(validateCron('99 9 * * *').valid).toBe(false) // 分越界
  })
})

describe('shared/cron.nextOccurrence', () => {
  it('返回 from 之后的下一个命中时刻', () => {
    const from = new Date('2026-08-24T08:00:00Z')
    const next = nextOccurrence('0 9 * * *', from, 'UTC')
    expect(next).not.toBeNull()
    expect(next!.getUTCHours()).toBe(9)
    expect(next!.getTime()).toBeGreaterThan(from.getTime())
  })
  it('尊重 IANA 时区', () => {
    // Asia/Shanghai 为 UTC+8，当地时间 09:00 = UTC 01:00
    const from = new Date('2026-08-24T00:30:00+08:00')
    const next = nextOccurrence('0 9 * * *', from, 'Asia/Shanghai')
    expect(next).not.toBeNull()
    expect(next!.getUTCHours()).toBe(1)
  })
  it('非法表达式返回 null', () => {
    expect(nextOccurrence('bad', new Date())).toBeNull()
  })
})

describe('shared/cron.previewNextRun', () => {
  it('预览返回未来时刻', () => {
    const from = new Date('2026-08-24T10:00:00Z')
    const next = previewNextRun(makeSch({ cron: '0 9 * * *' }), from)
    expect(next).not.toBeNull()
    expect(next!.getTime()).toBeGreaterThan(from.getTime())
  })
  it('非法 cron 返回 null', () => {
    expect(previewNextRun(makeSch({ cron: 'nope' }))).toBeNull()
  })
})

describe('shared/cron.hasUpcomingOccurrence', () => {
  it('合法且可命中 → true', () => {
    expect(hasUpcomingOccurrence('0 9 * * *')).toBe(true)
    expect(hasUpcomingOccurrence('*/5 * * * *')).toBe(true)
  })
  it('语法合法但永不命中（2 月 30 日）→ false', () => {
    // 2 月没有 30 日，cron-parser 解析通过但无命中
    expect(hasUpcomingOccurrence('0 9 30 2 *')).toBe(false)
  })
  it('2 月 29 日在 5 年窗口内命中（覆盖下一个闰年 + 时分余量）→ true', () => {
    // 默认 5 年窗口：合法的「2 月 29 日」在下一个闰年会命中，不应误拦
    expect(hasUpcomingOccurrence('0 9 29 2 *')).toBe(true)
  })
  it('闰日之后第一天创建合法 2 月 29 日调度（含时分差）不会被误拦', () => {
    // 回归：旧 4 年窗口（1460 天）会因 1460.4 天的 gap 误杀此类合法调度
    const from = new Date('2028-03-01T00:00:00+08:00')
    expect(hasUpcomingOccurrence('0 9 29 2 *', from, 'Asia/Shanghai')).toBe(true)
  })
  it('非法表达式 → false', () => {
    expect(hasUpcomingOccurrence('bad')).toBe(false)
  })
})
