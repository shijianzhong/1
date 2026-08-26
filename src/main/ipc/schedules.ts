import { z, ZodError } from 'zod'
import type { Schedule, ScheduleAction } from '@shared/types'
import { IpcErrorThrow } from '@shared/types'
import { withHandler } from './handler'
import {
  listSchedules,
  createSchedule,
  updateSchedule,
  removeSchedule,
} from '../storage/schedules'
import { runScheduleNow } from '../scheduler/scheduler'
import { validateCron, hasUpcomingOccurrence, isValidTimeZone } from '../scheduler/cron'

// —— 定时任务 IPC（§定时任务）——
// 入参 Zod 校验（IPC 边界不做隐式 as 断言，畸形参数在入口结构化报错）。
// cron 表达式额外用 validateCron 校验 5 段合法性；messageKey 走 errors:schedules.*。

const IdSchema = z.string().min(1)

const OrchestrationActionSchema = z.object({
  type: z.literal('orchestration'),
  prompt: z.string().min(1),
  modelId: z.string().optional(),
})
const ShellActionSchema = z.object({
  type: z.literal('shell'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
})
const ActionSchema = z.discriminatedUnion('type', [OrchestrationActionSchema, ShellActionSchema])

const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  enabled: z.boolean().optional(),
  cron: z.string().min(1),
  timezone: z.string().optional(),
  action: ActionSchema,
  notifyOnComplete: z.boolean().optional(),
})

const UpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  cron: z.string().min(1).optional(),
  timezone: z.string().optional(),
  action: ActionSchema.optional(),
  notifyOnComplete: z.boolean().optional(),
})

function assertValidCron(cron: string): void {
  const r = validateCron(cron)
  if (!r.valid) {
    throw new IpcErrorThrow('errors:schedules.invalid_cron', r.error ?? 'cron 表达式无效')
  }
  // 可命中性探针（#14）：拦截「2 月 31 日」等语法合法但永不命中的表达式
  if (!hasUpcomingOccurrence(cron)) {
    throw new IpcErrorThrow(
      'errors:schedules.invalid_cron',
      '该 cron 表达式在可预见范围内无命中时刻',
    )
  }
}

/** IANA 时区合法性校验（§定时任务）：非法时区直接结构化报错，
 * 避免后续 nextOccurrence 返 null 导致 schedule 静默永不触发（根因防御）。 */
function assertValidTimezone(tz?: string): void {
  if (tz && !isValidTimeZone(tz)) {
    throw new IpcErrorThrow('errors:schedules.invalid_timezone', `时区「${tz}」不是合法的 IANA 时区`)
  }
}

/** Zod 解析：失败抛 IpcErrorThrow('errors:schedules.invalid_input', ...)，错误语义完整（§基线#4） */
function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  try {
    return schema.parse(input)
  } catch (e) {
    if (e instanceof ZodError) {
      const issue = e.issues[0]
      const loc = issue?.path.join('.') ?? ''
      throw new IpcErrorThrow(
        'errors:schedules.invalid_input',
        `参数校验失败${loc ? `（${loc}）` : ''}：${issue?.message ?? ''}`,
      )
    }
    throw e
  }
}

export function registerSchedulesHandlers(): void {
  withHandler<Schedule[]>('schedules:list', () => listSchedules())

  withHandler<Schedule>('schedules:create', (_e, inputRaw) => {
    const input = parseOrThrow(CreateSchema, inputRaw)
    assertValidCron(input.cron)
    assertValidTimezone(input.timezone)
    return createSchedule({
      name: input.name,
      enabled: input.enabled,
      cron: input.cron,
      timezone: input.timezone,
      action: input.action as ScheduleAction,
      notifyOnComplete: input.notifyOnComplete,
    })
  })

  withHandler<Schedule>('schedules:update', (_e, inputRaw) => {
    const parsed = parseOrThrow(z.object({ id: IdSchema, ...UpdateSchema.shape }), inputRaw)
    const { id, ...patch } = parsed
    if (patch.cron !== undefined) assertValidCron(patch.cron)
    if (patch.timezone !== undefined) assertValidTimezone(patch.timezone)
    const updated = updateSchedule(id, patch)
    if (!updated) throw new IpcErrorThrow('errors:schedules.not_found', '定时任务不存在')
    return updated
  })

  withHandler<{ ok: boolean }>('schedules:remove', (_e, inputRaw) => {
    const id = parseOrThrow(IdSchema, inputRaw)
    const ok = removeSchedule(id)
    if (!ok) throw new IpcErrorThrow('errors:schedules.not_found', '定时任务不存在')
    return { ok }
  })

  withHandler<Schedule>('schedules:toggle', (_e, inputRaw) => {
    const { id, enabled } = parseOrThrow(
      z.object({ id: IdSchema, enabled: z.boolean() }),
      inputRaw,
    )
    const updated = updateSchedule(id, { enabled })
    if (!updated) throw new IpcErrorThrow('errors:schedules.not_found', '定时任务不存在')
    return updated
  })

  withHandler<{ ok: boolean; error?: string; messageKey?: string }>('schedules:runNow', (_e, inputRaw) => {
    const id = parseOrThrow(IdSchema, inputRaw)
    return runScheduleNow(id)
  })
}
