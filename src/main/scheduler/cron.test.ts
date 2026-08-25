import { describe, expect, it } from 'vitest'
import { validateCron, nextOccurrence } from './cron'

describe('cron', () => {
  it('validateCron 接受合法 5 段表达式', () => {
    expect(validateCron('0 9 * * 1-5').valid).toBe(true)
    expect(validateCron('*/5 * * * *').valid).toBe(true)
    expect(validateCron('30 0 1 1 *').valid).toBe(true)
  })

  it('validateCron 拒绝空/段数不符/越界', () => {
    expect(validateCron('').valid).toBe(false)
    expect(validateCron('   ').valid).toBe(false)
    expect(validateCron('0 9 * *').valid).toBe(false) // 4 段
    expect(validateCron('99 9 * * *').valid).toBe(false) // 分越界
    expect(validateCron('0 9 * * 9').valid).toBe(false) // 周越界
  })

  it('nextOccurrence 返回 from 之后的下一个命中时刻', () => {
    const from = new Date('2026-08-24T08:00:00Z')
    const next = nextOccurrence('0 9 * * *', from, 'UTC')
    expect(next).not.toBeNull()
    expect(next!.getUTCHours()).toBe(9)
    expect(next!.getTime()).toBeGreaterThan(from.getTime())
  })

  it('nextOccurrence 尊重 IANA 时区', () => {
    // Asia/Shanghai 为 UTC+8，当地时间 09:00 = UTC 01:00
    const from = new Date('2026-08-24T00:30:00+08:00')
    const next = nextOccurrence('0 9 * * *', from, 'Asia/Shanghai')
    expect(next).not.toBeNull()
    expect(next!.getUTCHours()).toBe(1)
  })

  it('nextOccurrence 非法表达式返回 null', () => {
    expect(nextOccurrence('bad', new Date())).toBeNull()
  })
})
