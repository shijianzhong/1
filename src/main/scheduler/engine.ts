import type { Schedule } from '@shared/types'
import { nextOccurrence, previewNextRun } from '@shared/cron'

// —— 调度引擎（纯函数，§定时任务）——
// 不依赖存储/电子/文件系统，便于单测锁定边界。
// nextOccurrence/previewNextRun 已下沉 @shared/cron（主进程与渲染层共用，#13）。

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

// previewNextRun 从 @shared/cron re-export，供旧调用方与单测保持兼容
export { previewNextRun }

/**
 * 计算 fire 后应写回的 lastFiredAt 基准（纯函数，便于单测锁边界）：
 * - 普通 tick：基准 = occurrence（本次 cron 命中时刻）。
 * - 手动触发（advanceToNext）：推进到「下一个 cron 命中点」，
 *   避免手动跑完、tick 又在同窗口重复触发（#1）。
 * - 无可命中（cron 异常）时退回 occurrenceMs，不向前推进。
 *
 * 注意：用显式 advanceToNext 标志，而非比较 occurrenceMs === Date.now()——
 * 后者是两次独立调用，值几乎不可能相等，会导致整条分支成为死代码（已修）。
 */
export function resolveLastFiredBase(
  schedule: Schedule,
  occurrenceMs: number,
  advanceToNext: boolean,
): number {
  if (advanceToNext && schedule.cron) {
    return (
      nextOccurrence(schedule.cron, new Date(occurrenceMs), schedule.timezone)?.getTime() ??
      occurrenceMs
    )
  }
  return occurrenceMs
}
