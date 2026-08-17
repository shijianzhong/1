import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

// —— executeTool 的 run_events 注入单测（诊断问题 4/5 的事实源）——
// mock appendRunEvent 只验证「发了什么事件」，事件落库由 runEvents.test.ts 覆盖。

const appendRunEvent = vi.fn()
vi.mock('../storage/runEvents', () => ({
  appendRunEvent: (...args: unknown[]) => appendRunEvent(...args),
}))

const { registerTool, executeTool, clearTools } = await import('./registry')
const { grantSessionToolApproval, clearAllSessionToolApprovals } = await import('./sessionApprovals')

beforeEach(() => {
  clearTools()
  clearAllSessionToolApprovals()
  appendRunEvent.mockClear()
})
afterEach(() => {
  vi.useRealTimers()
})

interface CapturedEvent {
  runId: string | undefined
  type: string
  payload: Record<string, unknown> | undefined
  sessionId: string | undefined
}

function captured(): CapturedEvent[] {
  return appendRunEvent.mock.calls.map((c) => ({
    runId: c[0] as string | undefined,
    type: c[1] as string,
    payload: c[2] as Record<string, unknown> | undefined,
    sessionId: c[3] as string | undefined,
  }))
}

const CTX = { runId: 'run-1', sessionId: 'sess-1', nodeId: 'node-a' }

describe('executeTool run_events 注入', () => {
  it('成功执行：tool.started + tool.completed（带 runId/nodeId/toolUseId/argsSummary/ms）', async () => {
    registerTool('echo', 'echo', z.object({ text: z.string() }), async (a) => (a as { text: string }).text)
    await executeTool('echo', { text: 'hi' }, 'tu_1', CTX)

    const events = captured()
    expect(events.map((e) => e.type)).toEqual(['tool.started', 'tool.completed'])
    expect(events[0]).toMatchObject({ runId: 'run-1', sessionId: 'sess-1' })
    expect(events[0].payload).toMatchObject({
      tool: 'echo', toolUseId: 'tu_1', nodeId: 'node-a', argsSummary: '{"text":"hi"}',
    })
    expect(events[1].payload).toMatchObject({
      tool: 'echo', toolUseId: 'tu_1', isError: false, attempts: 1,
    })
    expect(events[1].payload?.ms).toBeTypeOf('number')
  })

  it('无 runId（单测/无运行上下文）：事件以 undefined runId 发出，由存储层跳过', async () => {
    registerTool('echo', 'echo', z.object({}), async () => 'ok')
    await executeTool('echo', {}, 'tu_1', {})
    const events = captured()
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.runId === undefined)).toBe(true)
  })

  it('preCheck 硬拦截：tool.prechecked(blocked) 且无 tool.started', async () => {
    registerTool('danger', 'd', z.object({ cmd: z.string() }), async () => 'ok', 'auto', {
      preCheck: () => ({ ok: false, error: 'dangerous_command' }),
    })
    const r = await executeTool('danger', { cmd: 'rm -rf /' }, 'tu_2', CTX)
    expect(r.isError).toBe(true)
    const events = captured()
    expect(events.map((e) => e.type)).toEqual(['tool.prechecked'])
    expect(events[0].payload).toMatchObject({
      tool: 'danger', blocked: true, error: 'dangerous_command',
    })
  })

  it('审批弹窗批准：requested → decided(via=prompt) → started → completed', async () => {
    registerTool('shell_run', 's', z.object({ cmd: z.string() }), async () => 'done', 'always')
    const onApprove = vi.fn().mockResolvedValue({ approved: true, reason: 'approved' })
    await executeTool('shell_run', { cmd: 'ls' }, 'tu_3', { ...CTX, onApprove })

    const types = captured().map((e) => e.type)
    expect(types).toEqual([
      'tool.approval.requested',
      'tool.approval.decided',
      'tool.started',
      'tool.completed',
    ])
    const decided = captured()[1]
    expect(decided.payload).toMatchObject({ approved: true, reason: 'approved', via: 'prompt' })
  })

  it('会话放行命中：只发 decided(via=session_bypass)，不发 requested、不弹窗', async () => {
    grantSessionToolApproval('sess-1', 'shell_run')
    registerTool('shell_run', 's', z.object({ cmd: z.string() }), async () => 'done', 'always')
    const onApprove = vi.fn()
    await executeTool('shell_run', { cmd: 'ls' }, 'tu_4', { ...CTX, onApprove })

    expect(onApprove).not.toHaveBeenCalled()
    const events = captured()
    expect(events.map((e) => e.type)).toEqual([
      'tool.approval.decided',
      'tool.started',
      'tool.completed',
    ])
    expect(events[0].payload).toMatchObject({
      approved: true, reason: 'approved_session', via: 'session_bypass',
    })
  })

  it('审批拒绝：requested + decided(approved=false, reason=denied)，无 started', async () => {
    registerTool('shell_run', 's', z.object({ cmd: z.string() }), async () => 'done', 'always')
    const onApprove = vi.fn().mockResolvedValue({ approved: false, reason: 'denied' })
    const r = await executeTool('shell_run', { cmd: 'ls' }, 'tu_5', { ...CTX, onApprove })

    expect(r.isError).toBe(true)
    const events = captured()
    expect(events.map((e) => e.type)).toEqual(['tool.approval.requested', 'tool.approval.decided'])
    expect(events[1].payload).toMatchObject({ approved: false, reason: 'denied', via: 'prompt' })
  })

  it('重试耗尽：tool.started + tool.failed(attempts=4)', async () => {
    vi.useFakeTimers()
    registerTool('flaky', 'f', z.object({}), async () => {
      throw new Error('boom')
    })
    const p = executeTool('flaky', {}, 'tu_6', CTX)
    await vi.runAllTimersAsync()
    const r = await p
    expect(r.isError).toBe(true)
    const events = captured()
    expect(events.map((e) => e.type)).toEqual(['tool.started', 'tool.failed'])
    expect(events[1].payload).toMatchObject({ tool: 'flaky', error: 'boom', attempts: 4 })
  })

  it('handler 经 ctx.toolUseId 拿到本次调用 id（ask_user 事件关联 tool call 用）', async () => {
    let seenToolUseId: string | undefined
    registerTool('probe', 'p', z.object({}), async (_a, ctx) => {
      seenToolUseId = ctx.toolUseId
      return 'ok'
    })
    await executeTool('probe', {}, 'tu_7', CTX)
    expect(seenToolUseId).toBe('tu_7')
  })
})
