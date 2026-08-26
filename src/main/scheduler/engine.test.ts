import { describe, expect, it } from 'vitest'
import type { Schedule } from '@shared/types'
import { computeDueSchedules, previewNextRun, resolveLastFiredBase } from './engine'

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

const t = (iso: string) => new Date(iso).getTime()

describe('engine.computeDueSchedules', () => {
  it('disabled 调度不计入', () => {
    const now = new Date('2026-08-24T10:00:00Z')
    const due = computeDueSchedules([makeSch({ enabled: false })], now)
    expect(due).toHaveLength(0)
  })

  it('下一次命中仍在未来 → 不计入', () => {
    const now = new Date('2026-08-24T08:00:00Z')
    const due = computeDueSchedules(
      [makeSch({ createdAt: t('2026-08-24T07:00:00Z'), lastFiredAt: null, cron: '0 9 * * *' })],
      now,
    )
    expect(due).toHaveLength(0)
  })

  it('基准之后有过期档（错过）→ 计入，occurrence 取该档', () => {
    const now = new Date('2026-08-24T10:00:00Z')
    const due = computeDueSchedules(
      [makeSch({ createdAt: t('2026-08-24T07:00:00Z'), lastFiredAt: null, cron: '0 9 * * *' })],
      now,
    )
    expect(due).toHaveLength(1)
    expect(due[0].occurrence).toBe(t('2026-08-24T09:00:00Z'))
  })

  it('已触发且下次在未来 → 不计入', () => {
    const now = new Date('2026-08-24T10:00:00Z')
    const due = computeDueSchedules(
      [makeSch({ lastFiredAt: t('2026-08-24T09:00:00Z'), cron: '0 9 * * *' })],
      now,
    )
    expect(due).toHaveLength(0)
  })

  it('lastFiredAt 在上一档、下一档已到 → 计入（逐 tick 追平，仅补一发）', () => {
    const now = new Date('2026-08-25T10:00:00Z')
    const due = computeDueSchedules(
      [makeSch({ lastFiredAt: t('2026-08-24T09:00:00Z'), cron: '0 9 * * *' })],
      now,
    )
    expect(due).toHaveLength(1)
    expect(due[0].occurrence).toBe(t('2026-08-25T09:00:00Z'))
  })
})

describe('engine.resolveLastFiredBase', () => {
  it('tick（advanceToNext=false）→ 基准取 occurrence 本身', () => {
    const sch = makeSch({ cron: '0 9 * * *' })
    const occ = t('2026-08-24T09:00:00Z')
    expect(resolveLastFiredBase(sch, occ, false)).toBe(occ)
  })

  it('手动触发（advanceToNext=true）→ 基准推进到下一命中点（> occurrence）', () => {
    const sch = makeSch({ cron: '0 9 * * *', timezone: 'UTC' })
    const occ = t('2026-08-24T08:00:00Z')
    const base = resolveLastFiredBase(sch, occ, true)
    expect(base).toBeGreaterThan(occ)
    // 应为当天 09:00（下一命中），而非 occ 本身
    expect(base).toBe(t('2026-08-24T09:00:00Z'))
  })

  it('手动触发但 cron 异常 → 退回 occurrenceMs，不向前推进', () => {
    const sch = makeSch({ cron: 'nope' })
    const occ = t('2026-08-24T08:00:00Z')
    expect(resolveLastFiredBase(sch, occ, true)).toBe(occ)
  })
})

describe('engine.previewNextRun', () => {
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
