import { describe, expect, it } from 'vitest'
import { REPLAY_MAX_STEP_MS, REPLAY_MIN_STEP_MS, activeSeqOf, buildReplayPlan } from './runReplay'
import type { RunEventInfo } from '@shared/types'

function ev(seq: number, createdAt: number, type = 'tool.started'): RunEventInfo {
  return { id: seq, runId: 'r1', sessionId: null, seq, type, payload: {}, createdAt }
}

describe('buildReplayPlan', () => {
  it('空事件 → 空步骤、总时长 0', () => {
    const plan = buildReplayPlan([])
    expect(plan.steps).toEqual([])
    expect(plan.totalMs).toBe(0)
  })

  it('单事件 → 一步、delayMs=0', () => {
    const plan = buildReplayPlan([ev(1, 1000)])
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].delayMs).toBe(0)
    expect(plan.totalMs).toBe(0)
  })

  it('按 seq 升序（输入乱序也修正）', () => {
    const plan = buildReplayPlan([ev(3, 3000), ev(1, 1000), ev(2, 2000)])
    expect(plan.steps.map((s) => s.event.seq)).toEqual([1, 2, 3])
  })

  it('真实间隔在 [MIN,MAX] 内 → 原样保留', () => {
    const plan = buildReplayPlan([ev(1, 1000), ev(2, 1000 + 800), ev(3, 1000 + 800 + 1200)])
    expect(plan.steps[1].delayMs).toBe(800)
    expect(plan.steps[2].delayMs).toBe(1200)
    expect(plan.totalMs).toBe(2000)
  })

  it('间隔超过 MAX → 封顶', () => {
    const plan = buildReplayPlan([ev(1, 1000), ev(2, 1000 + 60_000)])
    expect(plan.steps[1].delayMs).toBe(REPLAY_MAX_STEP_MS)
    expect(plan.totalMs).toBe(REPLAY_MAX_STEP_MS)
  })

  it('间隔为 0 / 负 / 非有限 → 回退到 MIN', () => {
    const plan = buildReplayPlan([
      ev(1, 1000),
      ev(2, 1000), // 0 间隔
      ev(3, 900), // 时钟回拨（负）
      ev(4, NaN as unknown as number), // 非有限
    ])
    expect(plan.steps[1].delayMs).toBe(REPLAY_MIN_STEP_MS)
    expect(plan.steps[2].delayMs).toBe(REPLAY_MIN_STEP_MS)
    expect(plan.steps[3].delayMs).toBe(REPLAY_MIN_STEP_MS)
    expect(plan.totalMs).toBe(REPLAY_MIN_STEP_MS * 3)
  })
})

describe('activeSeqOf', () => {
  const plan = buildReplayPlan([ev(1, 1000), ev(2, 2000), ev(3, 3000)])

  it('cursor=0 → null（尚未开始）', () => {
    expect(activeSeqOf(plan, 0)).toBeNull()
  })

  it('cursor=N → 第 N 步事件 seq', () => {
    expect(activeSeqOf(plan, 1)).toBe(1)
    expect(activeSeqOf(plan, 3)).toBe(3)
  })

  it('cursor 越界 → null', () => {
    expect(activeSeqOf(plan, 4)).toBeNull()
  })
})
