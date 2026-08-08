import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  newRequestId,
  rejectAllUserInputs,
  rejectUserInputsForRun,
  resolveUserInput,
  waitForUserInput,
} from './userInput'

// —— HITL 用户输入等待队列单测 ——
// resolve / timeout / abort / rejectAll 四态；ask_user 工具侧把 rejection 转错误 JSON。

describe('orchestrator/userInput', () => {
  beforeEach(() => {
    rejectAllUserInputs('test_reset')
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolveUserInput：按 requestId 找回并 resolve 答案', async () => {
    const id = newRequestId()
    const p = waitForUserInput(id, { nodeId: 'n1', question: '喜欢什么风格？' })
    expect(resolveUserInput(id, '简约')).toBe(true)
    await expect(p).resolves.toBe('简约')
  })

  it('resolveUserInput：未知 requestId 返回 false', () => {
    expect(resolveUserInput('req_不存在', 'x')).toBe(false)
  })

  it('重复作答：第二次 resolve 返回 false（已结算）', async () => {
    const id = newRequestId()
    const p = waitForUserInput(id, { nodeId: 'n1', question: 'q' })
    expect(resolveUserInput(id, 'a1')).toBe(true)
    expect(resolveUserInput(id, 'a2')).toBe(false)
    await expect(p).resolves.toBe('a1')
  })

  it('超时：30min 无作答 → reject(user_input_timeout)', async () => {
    vi.useFakeTimers()
    const id = newRequestId()
    const p = waitForUserInput(id, { nodeId: 'n1', question: 'q' })
    const assertion = expect(p).rejects.toThrow('user_input_timeout')
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1)
    await assertion
    // 超时后再作答已无效
    expect(resolveUserInput(id, 'late')).toBe(false)
  })

  it('abort：signal 取消 → reject(aborted)', async () => {
    const id = newRequestId()
    const ac = new AbortController()
    const p = waitForUserInput(id, { nodeId: 'n1', question: 'q' }, ac.signal)
    ac.abort()
    await expect(p).rejects.toThrow('aborted')
  })

  it('abort 先于挂起：signal 已 aborted → 立即 reject', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(
      waitForUserInput(newRequestId(), { nodeId: 'n1', question: 'q' }, ac.signal),
    ).rejects.toThrow('aborted')
  })

  it('rejectAllUserInputs：批量驳回（取消运行/退出），返回驳回数', async () => {
    const id1 = newRequestId()
    const id2 = newRequestId()
    const p1 = waitForUserInput(id1, { nodeId: 'n1', question: 'q1' })
    const p2 = waitForUserInput(id2, { nodeId: 'n2', question: 'q2' })
    expect(rejectAllUserInputs('aborted')).toBe(2)
    await expect(p1).rejects.toThrow('aborted')
    await expect(p2).rejects.toThrow('aborted')
    expect(rejectAllUserInputs('aborted')).toBe(0)
  })

  it('rejectUserInputsForRun：只驳回指定 run，不影响其它通道', async () => {
    const homeId = newRequestId()
    const orchId = newRequestId()
    const homeP = waitForUserInput(homeId, { nodeId: 'home', question: 'q1' }, undefined, 'home_1')
    const orchP = waitForUserInput(orchId, { nodeId: 'n1', question: 'q2' }, undefined, 'orch_1')
    expect(rejectUserInputsForRun('home_1', 'run_finished')).toBe(1)
    await expect(homeP).rejects.toThrow('run_finished')
    // orch 仍可作答
    expect(resolveUserInput(orchId, 'ok')).toBe(true)
    await expect(orchP).resolves.toBe('ok')
  })
})
