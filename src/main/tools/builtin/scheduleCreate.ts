import { z } from 'zod'
import { registerTool } from '../registry'
import { createSchedule } from '../../storage/schedules'
import { validateCron, hasUpcomingOccurrence, nextOccurrence, isValidTimeZone, formatLocal } from '../../scheduler/cron'
import type { ScheduleAction } from '@shared/types'

// —— 对话内创建定时任务工具（主 Agent 在首页聊天直接落库，§定时任务）——
// 用户自然语言表达周期触发意图时调用：先 ask_user 确认（cron 人类可读化 + 下次运行 + 动作摘要），
// 用户答肯定词才 createSchedule 落库。调度引擎 15s tick 轮询自动感知新 schedule，无需 reload。
//
// 设计要点：
// - cron 由 LLM 直写 5 段表达式；validateCron + hasUpcomingOccurrence 兜底拦截非法/永不命中，
//   失败返 invalid_cron 错误附原因，LLM 据此自我修正重试（铁律11 不抛异常）。
// - action 是 orchestration|shell 二选一（discriminatedUnion 运行时校验）；⚠️ zodToJsonSchema
//   不支持 discriminatedUnion（走 default 返空 {}），故第 6 参 inputSchemaOverride 手写 oneOf
//   JSON Schema 给 LLM 可见（与 ipc/schedules.ts 的 ActionSchema 等价）。
// - approvalMode='auto'：handler 内 ask_user 已是用户确认关，落库只写 JSON 不执行命令，不重复审批。

// —— 运行时校验 schema（safeParse 用，registry 第 3 参）——
const OrchestrationSchema = z.object({
  type: z.literal('orchestration'),
  prompt: z.string().min(1),
  modelId: z.string().optional(),
})
const ShellSchema = z.object({
  type: z.literal('shell'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
})
const ActionSchema = z.discriminatedUnion('type', [OrchestrationSchema, ShellSchema])

const ParamsSchema = z.object({
  name: z.string().min(1).max(120),
  cron: z.string().min(1),
  action: ActionSchema,
  timezone: z.string().optional(),
  notifyOnComplete: z.boolean().optional(),
})

// —— LLM 可见 JSON Schema（第 6 参 inputSchemaOverride，手写 oneOf 绕过 zodToJsonSchema 限制）——
// 与 ipc/schedules.ts 的 CreateSchema 等价，避免两处漂移。
const inputSchemaOverride = {
  type: 'object',
  required: ['name', 'cron', 'action'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120, description: '任务名称' },
    cron: {
      type: 'string',
      minLength: 1,
      description:
        '5 段 cron 表达式：分 时 日 月 周。*/N=每 N 单位。0 9 * * *=每天9点；*/5 * * * *=每5分钟；0 9 * * 1-5=工作日9点。不要 6 段或秒级。',
    },
    action: {
      oneOf: [
        {
          type: 'object',
          required: ['type', 'prompt'],
          properties: {
            type: { type: 'string', const: 'orchestration' },
            prompt: { type: 'string', description: '触发时喂给 One 编排的提示词' },
            modelId: { type: 'string', description: '可选：覆盖默认模型名' },
          },
        },
        {
          type: 'object',
          required: ['type', 'command'],
          properties: {
            type: { type: 'string', const: 'shell' },
            command: { type: 'string', description: '可执行文件绝对路径或 PATH 中的命令名（execFile 不开 shell）' },
            args: { type: 'array', items: { type: 'string' }, description: '参数数组（不拼 shell 字符串）' },
            cwd: { type: 'string', description: '可选工作目录（绝对路径）' },
            timeoutMs: { type: 'integer', minimum: 1, maximum: 3600000, description: '超时毫秒，默认 60000' },
          },
        },
      ],
    },
    timezone: { type: 'string', description: 'IANA 时区如 Asia/Shanghai；留空用系统本地时区' },
    notifyOnComplete: { type: 'boolean', description: '完成后桌面通知，默认 false' },
  },
}

/** 判定用户回答是否为肯定（确认/yes/好/是/对 等，大小写不敏感） */
function isAffirmative(answer: string): boolean {
  const s = answer.trim().toLowerCase()
  if (!s) return false
  // 肯定词：yes/y/ok/确认/好/是/对/可以/行/同意/确认创建
  const aff = ['yes', 'y', 'ok', 'okay', '确认', '好', '好的', '是', '对', '可以', '行', '同意', '确认创建', '创建']
  // 否定词优先（避免「不好」「不行」「别」误判）
  const neg = ['no', 'n', '不', '不要', '不行', '别', '算了', '取消', '拒绝', 'nope']
  if (neg.some((w) => s === w || s.startsWith(w))) return false
  return aff.some((w) => s === w || s.startsWith(w) || s.includes(w))
}

/** 人类可读化 cron 摘要（粗粒度，用于确认文案；精确语义以 nextOccurrence 为准） */
function cronSummary(cron: string): string {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return cron
  const [m, h, d, mon, w] = parts
  const timeStr = /^\d+$/.test(h) && /^\d+$/.test(m) ? `${h.padStart(2, '0')}:${m.padStart(2, '0')}` : `${m} ${h}`
  if (m.startsWith('*/')) return `每 ${m.slice(2)} 分钟`
  if (h.startsWith('*/')) return `每 ${h.slice(2)} 小时（第 ${m} 分钟）`
  if (d !== '*' || mon !== '*' || w !== '*') return `cron ${cron}（${timeStr}）`
  return `每天 ${timeStr}`
}

function actionSummary(action: ScheduleAction): string {
  if (action.type === 'orchestration') {
    const p = action.prompt.length > 60 ? action.prompt.slice(0, 60) + '…' : action.prompt
    return `跑编排（prompt: ${p}${action.modelId ? `，模型 ${action.modelId}` : ''}）`
  }
  return `执行命令 ${action.command}${action.args?.length ? ' ' + action.args.join(' ') : ''}`
}

/** 注册对话内创建定时任务工具 */
export function registerScheduleCreateTool(): void {
  registerTool(
    'schedule_create',
    '当用户表达周期性/定时触发意图（如「每天几点」「每周」「每月」「定时」「每隔 N」跑某编排或命令）时调用，'
      + '在对话内直接创建定时任务，不必跳转定时任务页。调用前须已跟用户澄清具体时刻/周期与触发动作。'
      + '\n\n规则：'
      + '（1）一次性任务不要用本工具，直接调普通工具即可；'
      + '（2）cron 必须是 5 段标准表达式「分 时 日 月 周」，*/N 表示每 N 单位，'
      + '0 9 * * * = 每天 9 点，*/5 * * * * = 每 5 分钟，0 9 * * 1-5 = 工作日 9 点；不要写 6 段或秒级；'
      + '（3）cron 非法或永不命中（如 2 月 30 日）会返回 invalid_cron 错误并附具体原因，据此修正表达式后重试；'
      + '（4）action 二选一：orchestration（到点跑 One 编排，prompt 喂给 agent）/ shell（execFile 执行固定命令，不开 shell）；'
      + '（5）调用后会向用户弹出确认（展示 cron 人类可读摘要 + 下次运行时刻 + 动作摘要），用户确认 yes 才落库，'
      + '未确认不会创建——不要向用户宣称已创建成功，须以工具返回结果为准。',
    ParamsSchema,
    async (args, ctx) => {
      const { name, cron, action, timezone, notifyOnComplete } = args as {
        name: string
        cron: string
        action: ScheduleAction
        timezone?: string
        notifyOnComplete?: boolean
      }

      // 1. cron 硬校验：5 段合法性
      const vr = validateCron(cron)
      if (!vr.valid) {
        return {
          ok: false,
          error: 'invalid_cron',
          hint: `cron 表达式非法：${vr.error ?? '未知原因'}。须为 5 段「分 时 日 月 周」，如 0 9 * * *。请修正后重试。`,
        }
      }
      // 2. 时区合法性校验：拦截非法 IANA 时区（须排在可命中性探针之前，
      // 否则非法时区会让 nextOccurrence 抛错返 null，被误判为「永不命中」→ invalid_cron）
      if (timezone && !isValidTimeZone(timezone)) {
        return {
          ok: false,
          error: 'invalid_timezone',
          hint: `时区「${timezone}」不是合法的 IANA 时区（如 Asia/Shanghai、America/New_York）。请修正后重试。`,
        }
      }
      // 3. 可命中校验：拦截语法合法但永不命中（2 月 30 日）
      if (!hasUpcomingOccurrence(cron, new Date(), timezone)) {
        return {
          ok: false,
          error: 'invalid_cron',
          hint: '该 cron 表达式语法合法但未来 5 年内无任何命中时刻（如 2 月 30 日不存在）。请改用有效日期/周期。',
        }
      }

      // 3. 算下次运行时刻（给用户看，统一当地时间的 YYYY-MM-DD HH:mm）
      const nextRun = nextOccurrence(cron, new Date(), timezone)
      const nextRunLabel = nextRun ? formatLocal(nextRun) : '无法计算'

      // 4. 拼确认文案
      const tzLabel = timezone || '系统本地时区'
      const question =
        `将创建定时任务「${name}」：\n`
        + `  计划：${cronSummary(cron)}（时区 ${tzLabel}）\n`
        + `  动作：${actionSummary(action)}\n`
        + `  下次运行：${nextRunLabel}\n`
        + `确认创建吗？（回答「确认」/「yes」创建，其他视为取消）`

      // 5. HITL 确认桥
      if (!ctx.onAskUser) {
        return {
          ok: false,
          error: 'user_input_unavailable',
          hint: '当前运行环境无法与用户交互确认，未创建。请在可交互的会话中重试。',
        }
      }
      let answer: string
      try {
        answer = await ctx.onAskUser({ question, context: '定时任务创建确认' })
      } catch {
        return {
          ok: false,
          error: 'user_input_unavailable',
          hint: '用户未作答（超时或运行被取消），未创建定时任务。',
        }
      }

      // 6. 判定肯定词
      if (!isAffirmative(answer)) {
        return { ok: false, error: 'user_declined', hint: `用户未确认（回答：${answer || '空'}），未创建定时任务。` }
      }

      // 7. 落库（createSchedule 生成 sch_ id + 原子写盘；scheduler 15s tick 自动感知）
      const schedule = createSchedule({
        name,
        cron,
        timezone,
        action,
        notifyOnComplete,
      })

      // 8. 算落库后的 nextRun（基于 createdAt，与引擎 computeDueSchedules 一致），统一当地时间
      const afterCreate = nextOccurrence(cron, new Date(schedule.createdAt), timezone)
      const afterCreateLabel = afterCreate ? formatLocal(afterCreate) : null

      return {
        ok: true,
        scheduleId: schedule.id,
        // nextRun：本地可读 "YYYY-MM-DD HH:mm"，与上方确认文案同时区，供 LLM 转述给用户
        nextRun: afterCreateLabel,
        // nextRunIso：ISO 8601（UTC），供程序化消费方解析（与 nextRun 区分，后者非 ISO）
        nextRunIso: afterCreate ? afterCreate.toISOString() : null,
        hint: `已创建定时任务「${name}」（id ${schedule.id}）。调度引擎最迟 15 秒内纳入轮询。下次运行：${
          afterCreate ? afterCreateLabel! : '无法计算'
        }。`,
      }
    },
    'auto',
    { inputSchemaOverride },
  )
}
