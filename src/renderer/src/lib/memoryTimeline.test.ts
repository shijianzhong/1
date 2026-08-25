import { describe, expect, it } from 'vitest'
import type { MemorySnapshot } from '@shared/types'
import { buildMemoryTimeline, groupByDate, type MemoryTimelineEntry } from './memoryTimeline'

// —— 记忆时间线聚合单测（§三之三 D + 铁律21）——
// 锁 buildMemoryTimeline 的排序/打平行为，与 groupByDate 的日期分组。

function snap(partial: Partial<MemorySnapshot> = {}): MemorySnapshot {
  return { l1: [], l2: [], l3: [], ...partial }
}

describe('buildMemoryTimeline', () => {
  it('空快照返回空数组', () => {
    expect(buildMemoryTimeline(snap())).toEqual([])
  })

  it('把 L1/L2/L3 打平为统一事件流并保留各自内容', () => {
    const out = buildMemoryTimeline(
      snap({
        l1: [{ sessionId: 's1', summary: '会话摘要', ts: 300 }],
        l2: [{ userId: 'local', sessionId: 's1', digest: '跨会话摘要', ts: 200 }],
        l3: [{ userId: 'local', key: 'preference:x', value: '事实值', ts: 100 }],
      }),
    )
    expect(out).toEqual<MemoryTimelineEntry[]>([
      { ts: 100, kind: 'l3', title: 'preference:x', content: '事实值', ref: 'preference:x' },
      { ts: 200, kind: 'l2', title: 's1', content: '跨会话摘要', ref: 's1' },
      { ts: 300, kind: 'l1', title: 's1', content: '会话摘要', ref: 's1' },
    ])
  })

  it('按 ts 升序；同 ts 时 L1→L2→L3 稳定排序', () => {
    const out = buildMemoryTimeline(
      snap({
        l1: [{ sessionId: 's', summary: 'L1', ts: 100 }],
        l2: [{ userId: 'local', digest: 'L2', ts: 100 }],
        l3: [{ userId: 'local', key: 'k', value: 'L3', ts: 100 }],
      }),
    )
    expect(out.map((e) => e.kind)).toEqual(['l1', 'l2', 'l3'])
  })

  it('L2 跨会话（无 sessionId）时 title 为空串', () => {
    const out = buildMemoryTimeline(snap({ l2: [{ userId: 'local', digest: 'd', ts: 1 }] }))
    expect(out[0].title).toBe('')
    expect(out[0].ref).toBeUndefined()
  })
})

describe('groupByDate', () => {
  it('按 YYYY-MM-DD 分组且保持组内顺序', () => {
    // 用本地中午 12:00 构造，任意时区下都不会跨日（避开 UTC 偏移导致的日期漂移）
    const entries = buildMemoryTimeline(
      snap({
        l3: [
          { userId: 'local', key: 'a', value: '1', ts: new Date(2026, 0, 1, 12).getTime() },
          { userId: 'local', key: 'b', value: '2', ts: new Date(2026, 0, 2, 12).getTime() },
        ],
      }),
    )
    const groups = groupByDate(entries)
    expect(groups.map((g) => g.date)).toEqual(['2026-01-01', '2026-01-02'])
    expect(groups[0].items).toHaveLength(1)
  })

  it('按本地时区分组（非 UTC）：本地 23:00 的记忆归当天而非次日', () => {
    // 回归：原实现用 toISOString 取 UTC 日期，东半球晚上 20:00 后的记忆会被归到次日。
    // 现用本地日期；本地 23:00 的条目必须落在本地日期，而非 UTC 次日。
    const lateLocal = new Date(2026, 0, 1, 23).getTime()
    const entries = buildMemoryTimeline(
      snap({ l3: [{ userId: 'local', key: 'x', value: 'v', ts: lateLocal }] }),
    )
    expect(groupByDate(entries)[0].date).toBe('2026-01-01')
  })
})
