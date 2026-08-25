import type { L1Summary, L2Digest, L3Fact, MemorySnapshot } from '@shared/types'

// —— 记忆时间线聚合（§三之三 D + 铁律21）——
// 把 L1/L2/L3 三路记忆打平成按时间升序的事件流，供 MemoryPage「时间线」标签页呈现
// 「记忆如何随对话演化」。纯函数、无副作用，便于单测锁行为。

export type MemoryTimelineKind = 'l1' | 'l2' | 'l3'

export interface MemoryTimelineEntry {
  ts: number
  kind: MemoryTimelineKind
  /** 展示标题：L1/L2 为 sessionId（L2 跨会话时为 ''），L3 为 key */
  title: string
  /** 主体内容：L1 summary / L2 digest / L3 value */
  content: string
  /** 关联键：L3 为 key；L1/L2 为 sessionId（可能为空） */
  ref?: string
}

const KIND_ORDER: Record<MemoryTimelineKind, number> = { l1: 0, l2: 1, l3: 2 }

/**
 * 将记忆快照打平为时间升序事件流。
 * 同 ts 时按 L1→L2→L3 稳定排序，保证渲染确定性。
 */
export function buildMemoryTimeline(snapshot: MemorySnapshot): MemoryTimelineEntry[] {
  const entries: MemoryTimelineEntry[] = []

  for (const s of snapshot.l1 as L1Summary[]) {
    entries.push({ ts: s.ts, kind: 'l1', title: s.sessionId, content: s.summary, ref: s.sessionId })
  }
  for (const d of snapshot.l2 as L2Digest[]) {
    entries.push({ ts: d.ts, kind: 'l2', title: d.sessionId ?? '', content: d.digest, ref: d.sessionId })
  }
  for (const f of snapshot.l3 as L3Fact[]) {
    entries.push({ ts: f.ts, kind: 'l3', title: f.key, content: f.value, ref: f.key })
  }

  entries.sort((a, b) => a.ts - b.ts || KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
  return entries
}

/** 按本地日期（YYYY-MM-DD）分组，供时间线渲染日分隔标题。 */
export function groupByDate(entries: MemoryTimelineEntry[]): Array<{ date: string; items: MemoryTimelineEntry[] }> {
  const groups: Array<{ date: string; items: MemoryTimelineEntry[] }> = []
  for (const e of entries) {
    const date = new Date(e.ts).toISOString().slice(0, 10)
    const last = groups[groups.length - 1]
    if (last && last.date === date) last.items.push(e)
    else groups.push({ date, items: [e] })
  }
  return groups
}
