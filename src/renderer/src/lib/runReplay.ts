import type { RunEventInfo } from '@shared/types'

// —— 运行事件「高亮回放」纯逻辑（无 React / 无 DOM 依赖，便于单测）——
// 回放是前端可视化：复用 /runs 详情已拉取的 events（按 seq 定序、createdAt 驱动节奏），
// 不新增任何 IPC。本模块只负责把事件序列推导成「每步应等待的时长」播放计划。

/** 单步最小停留（ms）：即便真实间隔为 0，也至少停留这么久，避免一闪而过 */
export const REPLAY_MIN_STEP_MS = 350
/** 单步最大停留（ms）：真实间隔再长也封顶，避免几分钟的空档把回放卡死 */
export const REPLAY_MAX_STEP_MS = 2200

export interface ReplayStep {
  /** 该步对应的事件（已按 seq 升序） */
  event: RunEventInfo
  /**
   * 从「上一步」推进到「本步」应等待的毫秒数。
   * 首步为 0（进入回放即立即可见），其后取自真实 createdAt 差值经 clamp。
   */
  delayMs: number
}

export interface ReplayPlan {
  /** 按 seq 升序的事件播放步骤 */
  steps: ReplayStep[]
  /** 总回放时长（不含首步延迟），= 各步 delayMs 之和 */
  totalMs: number
}

function clampStep(delta: number): number {
  if (!Number.isFinite(delta) || delta <= 0) return REPLAY_MIN_STEP_MS
  return Math.min(Math.max(delta, REPLAY_MIN_STEP_MS), REPLAY_MAX_STEP_MS)
}

/**
 * 由事件列表推导回放计划。
 * - 按 seq 升序（数据通常已有序，这里做防御性排序保证稳定）。
 * - 首步 delayMs=0（立即显示）；其后 = clamp(createdAt[i]-createdAt[i-1])。
 * 时钟回拨 / 相等 / 非有限值一律回到 MIN_STEP_MS，保证回放节奏可控。
 */
export function buildReplayPlan(events: RunEventInfo[]): ReplayPlan {
  const ordered = [...events].sort((a, b) => a.seq - b.seq)
  const steps: ReplayStep[] = []
  let totalMs = 0
  for (let i = 0; i < ordered.length; i++) {
    let delayMs = 0
    if (i > 0) {
      delayMs = clampStep(ordered[i].createdAt - ordered[i - 1].createdAt)
      totalMs += delayMs
    }
    steps.push({ event: ordered[i], delayMs })
  }
  return { steps, totalMs }
}

/** 当前 cursor（已揭示事件数）对应的「高亮事件 seq」；未开始（cursor=0）返回 null */
export function activeSeqOf(plan: ReplayPlan, cursor: number): number | null {
  if (cursor <= 0 || cursor > plan.steps.length) return null
  return plan.steps[cursor - 1].event.seq
}
