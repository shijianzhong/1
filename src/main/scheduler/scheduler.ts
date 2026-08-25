import type { Schedule } from '@shared/types'
import { computeDueSchedules } from './engine'
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

/** IPC 手动触发：立即跑一次，并写回 lastFiredAt=now（避免 tick 立刻重复触发） */
export async function runScheduleNow(id: string): Promise<{ ok: boolean; error?: string }> {
  const s = getSchedule(id)
  if (!s) return { ok: false, error: 'not_found' }
  if (running.has(id)) return { ok: false, error: 'already_running' }
  await fire(s, Date.now())
  return { ok: true }
}

/** 执行一次调度（按 action 类型分发），结束写回 lastFiredAt。失败仅告警，不向上抛 */
async function fire(schedule: Schedule, occurrenceMs: number): Promise<void> {
  if (running.has(schedule.id)) return
  running.add(schedule.id)
  try {
    if (schedule.action.type === 'orchestration') {
      const r = await runOrchestrationAction(schedule.action.prompt, {
        modelId: schedule.action.modelId,
        name: schedule.name,
      })
      if (schedule.notifyOnComplete) {
        notify(schedule.name, r.error ? `编排失败：${r.error}` : '编排已完成')
      }
    } else {
      const a = schedule.action
      const r = await runShellAction(a.command, a.args, a.cwd, a.timeoutMs)
      if (schedule.notifyOnComplete) {
        notify(
          schedule.name,
          r.error ? `脚本失败：${r.error}` : `脚本已完成（退出码 ${r.code ?? '?'}）`,
        )
      }
    }
  } catch (e) {
    logger.warn(`[scheduler] 执行失败 sch=${schedule.id}`, e)
  } finally {
    running.delete(schedule.id)
    setScheduleLastFired(schedule.id, occurrenceMs)
  }
}
