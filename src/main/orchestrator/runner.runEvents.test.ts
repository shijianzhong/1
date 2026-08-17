import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutorRequest, StreamEvent, WorkflowContext } from '@shared/types'
import type { Executor, RuntimeWorkflow } from './models'

// —— runner 的 run_events 注入单测（诊断问题 3 的事实源）——

const appendRunEvent = vi.fn()
vi.mock('../storage/runEvents', () => ({
  appendRunEvent: (...args: unknown[]) => appendRunEvent(...args),
}))

const { runWorkflow } = await import('./runner')

beforeEach(() => {
  appendRunEvent.mockClear()
})

interface CapturedEvent {
  runId: string | undefined
  type: string
  payload: Record<string, unknown> | undefined
}

function captured(): CapturedEvent[] {
  return appendRunEvent.mock.calls.map((c) => ({
    runId: c[0] as string | undefined,
    type: c[1] as string,
    payload: c[2] as Record<string, unknown> | undefined,
  }))
}

class EchoExecutor implements Executor {
  cache: import('@shared/types').OrchMessage[] = []
  cacheTokens = 0
  constructor(
    readonly id: string,
    private readonly respondText = 'ok',
  ) {}
  async *handle(req: ExecutorRequest, ctx: WorkflowContext): AsyncIterable<StreamEvent> {
    if (!req.shouldRespond) return
    this.cache.push({ role: 'assistant', author: this.id, content: this.respondText })
    await ctx.yield_output(this.respondText)
  }
}

/** broadcast 源：handle 时向 target 发 shouldRespond=false 消息（模拟 GroupChat 广播） */
class BroadcastExecutor implements Executor {
  cache: import('@shared/types').OrchMessage[] = []
  cacheTokens = 0
  constructor(
    readonly id: string,
    private readonly target: string,
  ) {}
  async *handle(_req: ExecutorRequest, ctx: WorkflowContext): AsyncIterable<StreamEvent> {
    this.cache.push({ role: 'assistant', author: this.id, content: 'bcast' })
    await ctx.send_message(
      { role: 'user', content: '广播', shouldRespond: false },
      this.target,
    )
    await ctx.yield_output('bcast')
  }
}

class FailExecutor implements Executor {
  cache: import('@shared/types').OrchMessage[] = []
  cacheTokens = 0
  constructor(readonly id: string) {}
  // eslint-disable-next-line require-yield
  async *handle(): AsyncIterable<StreamEvent> {
    throw new Error('node boom')
  }
}

function makeWf(executors: Map<string, Executor>, start: string, edges: Map<string, string[]> = new Map()): RuntimeWorkflow {
  return { executors, startExecutor: start, edges, conditions: new Map(), nodes: new Map() }
}

describe('runner run_events 注入', () => {
  it('线性两节点：node.scheduled / started / completed 全链路，事件挂到 runId', async () => {
    const wf = makeWf(
      new Map([
        ['A', new EchoExecutor('A')],
        ['B', new EchoExecutor('B')],
      ]),
      'A',
      new Map([['A', ['B']]]),
    )
    await runWorkflow(wf, { text: 'q', sessionId: 's1', runId: 'run-1' }, () => undefined)

    const events = captured()
    expect(events.every((e) => e.runId === 'run-1')).toBe(true)
    // superstep 0 调度 A；A 完成后 superstep 1 调度 B
    const scheduled = events.filter((e) => e.type === 'node.scheduled')
    expect(scheduled).toHaveLength(2)
    expect(scheduled[0].payload).toMatchObject({ superstep: 0, targets: ['A'] })
    expect(scheduled[1].payload).toMatchObject({ superstep: 1, targets: ['B'] })

    const started = events.filter((e) => e.type === 'node.started')
    expect(started.map((e) => e.payload?.nodeId)).toEqual(['A', 'B'])
    const completed = events.filter((e) => e.type === 'node.completed')
    expect(completed.map((e) => e.payload?.nodeId)).toEqual(['A', 'B'])
    expect(completed[0].payload?.ms).toBeTypeOf('number')
    // 本流程无 broadcast / 无失败
    expect(events.some((e) => e.type === 'node.cache_extended')).toBe(false)
    expect(events.some((e) => e.type === 'node.failed')).toBe(false)
  })

  it('broadcast（shouldRespond=false）：目标节点记 node.cache_extended 而非 started', async () => {
    const wf = makeWf(
      new Map<string, Executor>([
        ['SRC', new BroadcastExecutor('SRC', 'B')],
        ['B', new EchoExecutor('B')],
      ]),
      'SRC',
    )
    await runWorkflow(wf, { text: 'q', runId: 'run-2' }, () => undefined)

    const events = captured()
    const cacheExt = events.filter((e) => e.type === 'node.cache_extended')
    expect(cacheExt).toHaveLength(1)
    expect(cacheExt[0].payload?.nodeId).toBe('B')
    // B 未被调度执行（无 started/completed）
    expect(events.some((e) => e.type === 'node.started' && e.payload?.nodeId === 'B')).toBe(false)
  })

  it('executor 抛错：node.failed 带错误信息', async () => {
    const wf = makeWf(new Map([['X', new FailExecutor('X')]]), 'X')
    await runWorkflow(wf, { text: 'q', runId: 'run-3' }, () => undefined)

    const failed = captured().filter((e) => e.type === 'node.failed')
    expect(failed).toHaveLength(1)
    expect(failed[0].payload).toMatchObject({ nodeId: 'X', error: 'node boom' })
  })

  it('无 runId：事件以 undefined runId 发出（存储层跳过，零副作用）', async () => {
    const wf = makeWf(new Map([['A', new EchoExecutor('A')]]), 'A')
    await runWorkflow(wf, { text: 'q' }, () => undefined)
    const events = captured()
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.runId === undefined)).toBe(true)
  })
})
