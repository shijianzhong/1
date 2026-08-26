import { parseExpression } from 'cron-parser'
import type { Schedule } from './types'

// —— cron 跨进程共享纯函数（§定时任务）——
// 主进程（校验/引擎/调度）与渲染层（预览/实时校验）共用同一份实现，避免漂移：
// 升级 cron-parser 或调整 5 段规则时只改一处，UI 接受的与 backend 拒的保持一致。

export interface CronValidationResult {
  valid: boolean
  error?: string
}

/** 校验 cron 表达式是否合法（5 段：分 时 日 月 周） */
export function validateCron(expr: string): CronValidationResult {
  const trimmed = expr?.trim()
  if (!trimmed) return { valid: false, error: 'cron 表达式为空' }
  // cron-parser 对空/不足 5 段会静默兜底为默认值，这里显式要求恰好 5 段，
  // 避免调度器用默认 cron 静默运行（根因防御，非补丁）。
  const parts = trimmed.split(/\s+/)
  if (parts.length !== 5) {
    return { valid: false, error: `cron 需 5 段（分 时 日 月 周），当前 ${parts.length} 段` }
  }
  try {
    // 仅解析校验，不依赖当前时间
    parseExpression(trimmed)
    return { valid: true }
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function toDate(cronDate: unknown): Date {
  const cd = cronDate as { toDate?: () => Date }
  if (typeof cd.toDate === 'function') return cd.toDate()
  return cronDate as Date
}

/**
 * 返回 from 之后的下一个命中时刻（Date）；解析失败或无可命中返回 null。
 * tz 为 IANA 时区（如 'Asia/Shanghai'）；缺省用系统本地时区。
 */
export function nextOccurrence(expr: string, from: Date, tz?: string): Date | null {
  try {
    const interval = parseExpression(expr, {
      currentDate: from,
      tz: tz || undefined,
    })
    const next = interval.next()
    return toDate(next)
  } catch {
    return null
  }
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

/**
 * 可命中性探针（#14）：从 from 起未来 windowMs 内是否有至少一次命中。
 * 用于创建/更新时拦截「2 月 30 日」等语法合法但永不命中的表达式。
 * 窗口取 5 年（> 两闰年最大间隔 1461 天 + 时分余量）：确保合法的「2 月 29 日」
 * 即便在闰日之后第一天（如 2028-03-01 00:00，下一闰日约 1460.4 天后）创建也不会
 * 被误拦；同时仍能拦截 2 月 30/31 日这类永不命中表达式。
 * （早期 4 年窗口会因时分差越界，误杀闰日后第一天的合法 2 月 29 日调度，已修。）
 */
export function hasUpcomingOccurrence(
  expr: string,
  from: Date = new Date(),
  tz?: string,
  windowMs: number = 5 * 365 * 24 * 60 * 60 * 1000,
): boolean {
  const next = nextOccurrence(expr, from, tz)
  if (!next) return false
  return next.getTime() - from.getTime() <= windowMs
}
