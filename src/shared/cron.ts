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

/**
 * IANA 时区合法性校验（§定时任务）：用 Intl.DateTimeFormat 探活，
 * 非法时区抛 RangeError → 返回 false。跨运行时稳定（无需 Intl.supportedValuesOf）。
 * 用于创建/更新时拦截非法时区，避免后续 nextOccurrence 返 null 导致 schedule
 * 静默永不触发（根因防御，非补丁）。
 */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * 当地时刻格式化（§定时任务 UI/确认文案）：统一用进程本地时区渲染为
 * `YYYY-MM-DD HH:mm`，避免「确认文案本地、返回值 UTC」的不一致（#tz-consistency）。
 * 与时区无关的绝对语义以 cron/引擎的 nextOccurrence 为准。
 */
export function formatLocal(dt: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(
    dt.getMinutes(),
  )}`
}

// —— Cron 预设编辑器纯逻辑（§定时任务 UI）——
// 渲染层下拉选常见模式（每 N 分钟 / 每 N 小时 / 每日 / 每周 / 每月），「自定义」回退原始输入。
// detectPreset 从既有 cron 反推（编辑场景），presetToCron 由参数生成。纯函数便于单测。

export type CronMode = 'everyNMin' | 'everyNHour' | 'dailyAt' | 'weeklyAt' | 'monthlyAt' | 'custom'

export interface CronPresetState {
  mode: CronMode
  minuteInterval: number
  hourInterval: number
  hour: number
  minute: number
  dow: number
  dom: number
}

export const CRON_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const

const DEFAULT_PRESET: CronPresetState = {
  mode: 'custom',
  minuteInterval: 30,
  hourInterval: 6,
  hour: 9,
  minute: 0,
  dow: 1,
  dom: 1,
}

/** 从 cron 字符串反推预设；推不上返回 custom（保留默认参数） */
export function detectPreset(cron: string): CronPresetState {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return { ...DEFAULT_PRESET }
  const [m, h, d, mon, w] = parts
  // 每 N 分钟：*/N * * * *
  const minMatch = /^\*\/(\d+)$/.exec(m)
  if (minMatch && h === '*' && d === '*' && mon === '*' && w === '*') {
    return { ...DEFAULT_PRESET, mode: 'everyNMin', minuteInterval: Number(minMatch[1]) }
  }
  // 每 N 小时：0 */N * * *（分钟位=0，小时位=*/N）
  const hourMatch = /^\*\/(\d+)$/.exec(h)
  if (m === '0' && hourMatch && d === '*' && mon === '*' && w === '*') {
    return { ...DEFAULT_PRESET, mode: 'everyNHour', hourInterval: Number(hourMatch[1]) }
  }
  // 每月某日 H:M：M H D * *
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && /^\d+$/.test(d) && mon === '*' && w === '*') {
    return { ...DEFAULT_PRESET, mode: 'monthlyAt', minute: Number(m), hour: Number(h), dom: Number(d) }
  }
  // 每周某天 H:M：M H * * W
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && d === '*' && mon === '*' && /^\d+$/.test(w)) {
    return { ...DEFAULT_PRESET, mode: 'weeklyAt', minute: Number(m), hour: Number(h), dow: Number(w) }
  }
  // 每日 H:M：M H * * *
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && d === '*' && mon === '*' && w === '*') {
    return { ...DEFAULT_PRESET, mode: 'dailyAt', minute: Number(m), hour: Number(h) }
  }
  return { ...DEFAULT_PRESET }
}

/** 由预设状态生成 cron 字符串；custom 返回空串（由调用方保留原值） */
export function presetToCron(s: CronPresetState): string {
  switch (s.mode) {
    case 'everyNMin':
      return `*/${s.minuteInterval} * * * *`
    case 'everyNHour':
      return `0 */${s.hourInterval} * * *`
    case 'dailyAt':
      return `${s.minute} ${s.hour} * * *`
    case 'weeklyAt':
      return `${s.minute} ${s.hour} * * ${s.dow}`
    case 'monthlyAt':
      return `${s.minute} ${s.hour} ${s.dom} * *`
    default:
      return ''
  }
}
