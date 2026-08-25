import { parseExpression } from 'cron-parser'

// —— cron 解析封装（§定时任务）——
// 复用 cron-parser（v4）：parseExpression(expr, { currentDate, tz }).next() 返回 CronDate。
// 支持完整 5 段 cron（分 时 日 月 周）+ IANA 时区 + DST，正确处理末日(L)/命名(jan-dec,sun-sat)。

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
