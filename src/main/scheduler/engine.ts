import type { Schedule } from '@shared/types'
import { nextOccurrence } from './cron'

// —— 调度引擎（纯函数，§定时任务）——
// 不依赖存储/电子/文件系统，便于单测锁定边界。

export interface DueSchedule {
  schedule: Schedule
  /** 命中的本次触发时刻（epoch ms） */
  occurrence: number
}

/**
 * 计算当前到期的调度。
 * 对每个 enabled 调度：以 lastFiredAt（无则 createdAt）为基准算下一个命中时刻；
 * 若 <= now 视为到期。
 *
 * 错过策略（根因处理，非补丁）：基准取「上次实际触发时刻」，故 app 长时间关闭后重启，
 * 每次 tick 只补一发最新错过档（设为该 occurrence），逐 tick 自然追平，
 * 避免一次性补发全部积压导致风暴；也不会重复触发同一档（next 严格大于基准）。
 */
export function computeDueSchedules(schedules: Schedule[], now: Date): DueSchedule[] {
  const nowMs = now.getTime()
  const due: DueSchedule[] = []
  for (const s of schedules) {
    if (!s.enabled) continue
    const base = s.lastFiredAt != null ? new Date(s.lastFiredAt) : new Date(s.createdAt)
    const next = nextOccurrence(s.cron, base, s.timezone)
    if (next && next.getTime() <= nowMs) {
      due.push({ schedule: s, occurrence: next.getTime() })
    }
  }
  return due
}

/**
 * UI 预览：从「当前/上次触发」之后算起的下一次运行时刻。
 * 取 max(基准, from) 避免预览落在过去；cron 非法或无命中返回 null。
 */
export function previewNextRun(schedule: Schedule, from: Date = new Date()): Date | null {
  const base = schedule.lastFiredAt != null ? new Date(schedule.lastFiredAt) : from
  const after = new Date(Math.max(base.getTime(), from.getTime()))
  return nextOccurrence(schedule.cron, after, schedule.timezone)
}
