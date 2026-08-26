import type { Schedule } from '@shared/types'
import { computeDueSchedules, resolveLastFiredBase } from './engine'
import { runOrchestrationAction, runShellAction, notify } from './executors'
import {
  listSchedules,
  getSchedule,
  setScheduleLastFired,
} from '../storage/schedules'
import { logger } from '../logger'

// —— 调度主循环（§定时任务）——
// 主进程常驻 setInterval（默认 15s）tick：加载调度 → 算到期 → 逐个 fire（防重入）→ 写回 lastFiredAt。
// 错过策略在 engine.computeDueSchedules 内：每次只补一发最新错过档，逐 tick 自然追平，无风暴。

const TICK_MS = 15_000

let timer: ReturnType<typeof setInterval> | null = null
/** 运行中调度 id（防同一调度跨 tick 重叠执行） */
const running = new Set<string>()

export function startScheduler(): void {
  if (timer) return
  // 启动立即追平一次错过的档，随后周期
  void tick()
  timer = setInterval(() => void tick(), TICK_MS)
  logger.info('[scheduler] 已启动（tick=' + TICK_MS + 'ms）')
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

async function tick(): Promise<void> {
  const now = new Date()
  const due = computeDueSchedules(listSchedules(), now)
  for (const { schedule, occurrence } of due) {
    void fire(schedule, occurrence).catch((e) => logger.warn('[scheduler] fire 失败', e))
  }
}

/** IPC 手动触发：立即跑一次（fire-and-forget，不阻塞 IPC）。返回结构含 messageKey 供渲染层翻译 */
export async function runScheduleNow(
  id: string,
): Promise<{ ok: boolean; error?: string; messageKey?: string }> {
  const s = getSchedule(id)
  if (!s) return { ok: false, error: 'not_found', messageKey: 'errors:schedules.not_found' }
  if (running.has(id)) {
    return { ok: false, error: 'already_running', messageKey: 'errors:schedules.already_running' }
  }
  // fire-and-forget：编排可能跑数分钟，不阻塞 IPC；结果落 run_events + 可选通知
  // advanceToNext：手动触发把 lastFiredAt 推进到下一命中点，避免 tick 同窗口重复触发（#1）
  void fire(s, Date.now(), { advanceToNext: true }).catch((e) =>
    logger.warn(`[scheduler] runNow fire 失败 sch=${s.id}`, e),
  )
  return { ok: true }
}

/**
 * 执行一次调度（按 action 类型分发），结束写回 lastFiredAt。
 * 失败仅告警，不向上抛。手动触发时 occurrenceMs 取 Date.now()，
 * 但写回基准推进到「下一个 cron 命中点」，避免手动跑完 tick 又因同窗口到期重复触发（#1）。
 */
async function fire(
  schedule: Schedule,
  occurrenceMs: number,
  opts: { advanceToNext?: boolean } = {},
): Promise<void> {
  if (running.has(schedule.id)) return
  running.add(schedule.id)
  let succeeded = false
  try {
    if (schedule.action.type === 'orchestration') {
      const r = await runOrchestrationAction(schedule.action.prompt, {
        modelId: schedule.action.modelId,
        name: schedule.name,
      })
      succeeded = !r.error
      if (schedule.notifyOnComplete) {
        notify(schedule.name, r.error ? `Orchestration failed: ${r.error}` : 'Orchestration completed')
      }
    } else {
      const a = schedule.action
      const r = await runShellAction(a.command, a.args, a.cwd, a.timeoutMs)
      succeeded = !r.error
      if (schedule.notifyOnComplete) {
        notify(
          schedule.name,
          r.error ? `Script failed: ${r.error}` : `Script completed (exit ${r.code ?? '?'})`,
        )
      }
    }
  } catch (e) {
    logger.warn(`[scheduler] 执行失败 sch=${schedule.id}`, e)
  } finally {
    running.delete(schedule.id)
    // 写回基准：tick 用 occurrence（cron 命中时刻）；手动触发推进到下一命中点（#1 防双触发）
    const base = resolveLastFiredBase(schedule, occurrenceMs, opts.advanceToNext ?? false)
    const wrote = setScheduleLastFired(schedule.id, base)
    if (!wrote) {
      // 写失败：lastFiredAt 未推进，下一 tick 可能以旧基准重复触发同档（#5）
      // 仅成功执行时才视为「该推进」——失败时保留旧基准，让 tick 下次重试该档
      if (succeeded) {
        logger.error(
          `[scheduler] setScheduleLastFired 失败 sch=${schedule.id}，下 tick 可能重复触发`,
        )
      }
    }
  }
}
