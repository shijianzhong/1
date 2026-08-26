import { describe, expect, it } from 'vitest'
import {
  validateCron,
  nextOccurrence,
  previewNextRun,
  hasUpcomingOccurrence,
  detectPreset,
  presetToCron,
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

describe('shared/cron.detectPreset', () => {
  it('每 N 分钟：*/N * * * * → everyNMin', () => {
    const s = detectPreset('*/30 * * * *')
    expect(s.mode).toBe('everyNMin')
    expect(s.minuteInterval).toBe(30)
  })
  it('每 N 小时：0 */N * * * → everyNHour', () => {
    const s = detectPreset('0 */6 * * *')
    expect(s.mode).toBe('everyNHour')
    expect(s.hourInterval).toBe(6)
  })
  it('每日 H:M：M H * * * → dailyAt', () => {
    const s = detectPreset('30 9 * * *')
    expect(s.mode).toBe('dailyAt')
    expect(s.minute).toBe(30)
    expect(s.hour).toBe(9)
  })
  it('每周某天 H:M：M H * * W → weeklyAt', () => {
    const s = detectPreset('0 9 * * 5')
    expect(s.mode).toBe('weeklyAt')
    expect(s.hour).toBe(9)
    expect(s.dow).toBe(5)
  })
  it('每月某日 H:M：M H D * * → monthlyAt', () => {
    const s = detectPreset('0 9 15 * *')
    expect(s.mode).toBe('monthlyAt')
    expect(s.dom).toBe(15)
  })
  it('复杂表达式（区间/列表）→ custom', () => {
    expect(detectPreset('0 9 * * 1-5').mode).toBe('custom')
    expect(detectPreset('0,30 * * * *').mode).toBe('custom')
    expect(detectPreset('0 9,18 * * *').mode).toBe('custom')
  })
  it('段数不足 → custom', () => {
    expect(detectPreset('0 9 * *').mode).toBe('custom')
  })
})

describe('shared/cron.presetToCron', () => {
  it('everyNMin → */N * * * *', () => {
    expect(
      presetToCron({ mode: 'everyNMin', minuteInterval: 15, hourInterval: 1, hour: 0, minute: 0, dow: 0, dom: 0 }),
    ).toBe('*/15 * * * *')
  })
  it('everyNHour → 0 */N * * *', () => {
    expect(
      presetToCron({ mode: 'everyNHour', minuteInterval: 1, hourInterval: 3, hour: 0, minute: 0, dow: 0, dom: 0 }),
    ).toBe('0 */3 * * *')
  })
  it('dailyAt → M H * * *', () => {
    expect(
      presetToCron({ mode: 'dailyAt', minuteInterval: 1, hourInterval: 1, hour: 9, minute: 30, dow: 0, dom: 0 }),
    ).toBe('30 9 * * *')
  })
  it('weeklyAt → M H * * W', () => {
    expect(
      presetToCron({ mode: 'weeklyAt', minuteInterval: 1, hourInterval: 1, hour: 9, minute: 0, dow: 1, dom: 0 }),
    ).toBe('0 9 * * 1')
  })
  it('monthlyAt → M H D * *', () => {
    expect(
      presetToCron({ mode: 'monthlyAt', minuteInterval: 1, hourInterval: 1, hour: 9, minute: 0, dow: 0, dom: 15 }),
    ).toBe('0 9 15 * *')
  })
  it('custom → 空串', () => {
    expect(
      presetToCron({ mode: 'custom', minuteInterval: 1, hourInterval: 1, hour: 0, minute: 0, dow: 0, dom: 0 }),
    ).toBe('')
  })
})

describe('shared/cron 预设往返一致', () => {
  // detectPreset 与 presetToCron 对预设生成的 cron 应互逆（往返一致）
  const cases = [
    '*/30 * * * *',
    '0 */6 * * *',
    '30 9 * * *',
    '0 9 * * 5',
    '0 9 15 * *',
  ]
  for (const cron of cases) {
    it(`${cron} 反推 → 生成 → 应等于原值`, () => {
      const s = detectPreset(cron)
      expect(presetToCron(s)).toBe(cron)
    })
  }
})
