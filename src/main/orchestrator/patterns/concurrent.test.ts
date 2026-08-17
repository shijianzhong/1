import { describe, expect, it, vi } from 'vitest'
import type {
  AgentConfig,
  AgentRunCallbacks,
  AgentRunInput,
  StreamEvent,
} from '@shared/types'
import { Agent } from '../agent'
import { AgentExecutor } from './agent'
import { ConcurrentExecutor, buildConcurrent } from './concurrent'
import { runWorkflow } from '../runner'
import type { BuilderContext, Executor, RuntimeWorkflow } from '../models'

// —— Concurrent 黄金用例（§三 D + §三之三 G）——

function mockAgent(name: string, responseText: string): Agent {
  const config: AgentConfig = {
    name,
    instructions: `你是 ${name}`,
    modelId: 'mock',
    defaultOptions: { maxTokens: 16384 },
  }
  return {
    config,
    deps: {},
    run: vi.fn(async (input: AgentRunInput, _cb: AgentRunCallbacks) => ({
      messages: input.messages,
      finalText: responseText,
    })),
  } as unknown as Agent
}

function agentRunOf(ex: AgentExecutor): ReturnType<typeof vi.fn> {
  return (ex as unknown as { agent: { run: ReturnType<typeof vi.fn> } }).agent.run
}

describe('Concurrent 黄金用例', () => {
  it('fan-out：所有 participant 收到输入', async () => {
    const p1Agent = mockAgent('P1', 'P1产出')
    const p2Agent = mockAgent('P2', 'P2产出')
    const aggAgent = mockAgent('Agg', '聚合产出')

    const executors = new Map<string, Executor>()
    const edges = new Map<string, string[]>()
    const bctx: BuilderContext = {
      addExecutor(e) {
        executors.set(e.id, e)
      },
      addEdge(s, t) {
        const l = edges.get(s) ?? []
        l.push(t)
        edges.set(s, l)
      },
      addCondition() {},
    }

    buildConcurrent(
      {
        id: 'conc',
        type: 'concurrent',
        data: { participants: ['P1', 'P2'] },
        position: { x: 0, y: 0 },
      },
      [
        {
          config: {
            name: 'P1',
            instructions: '你是 P1',
            modelId: 'mock',
            defaultOptions: { maxTokens: 16384 },
          },
          llmOpts: {},
          agent: p1Agent,
        },
        {
          config: {
            name: 'P2',
            instructions: '你是 P2',
            modelId: 'mock',
            defaultOptions: { maxTokens: 16384 },
          },
          llmOpts: {},
          agent: p2Agent,
        },
      ],
      {
        config: {
          name: 'Agg',
          instructions: '你是聚合器',
          modelId: 'mock',
          defaultOptions: { maxTokens: 16384 },
        },
        llmOpts: {},
        agent: aggAgent,
      },
      bctx,
    )

    const wf: RuntimeWorkflow = {
      executors,
      startExecutor: 'conc',
      edges,
      conditions: new Map(),
      nodes: new Map(),
    }

    const events: StreamEvent[] = []
    await runWorkflow(wf, { text: '问题' }, (e) => events.push(e))

    // P1 P2 都被调用
    expect(agentRunOf(executors.get('P1') as AgentExecutor)).toHaveBeenCalled()
    expect(agentRunOf(executors.get('P2') as AgentExecutor)).toHaveBeenCalled()
  })

  it('fan-in 栅栏：等齐后才聚合（aggregator 收齐各 participant 最后 assistant 拼接）', async () => {
    const p1Agent = mockAgent('P1', 'P1产出')
    const p2Agent = mockAgent('P2', 'P2产出')
    const aggAgent = mockAgent('Agg', '聚合产出')

    const executors = new Map<string, Executor>()
    const edges = new Map<string, string[]>()
    const bctx: BuilderContext = {
      addExecutor(e) {
        executors.set(e.id, e)
      },
      addEdge(s, t) {
        const l = edges.get(s) ?? []
        l.push(t)
        edges.set(s, l)
      },
      addCondition() {},
    }

    buildConcurrent(
      {
        id: 'conc',
        type: 'concurrent',
        data: { participants: ['P1', 'P2'] },
        position: { x: 0, y: 0 },
      },
      [
        {
          config: {
            name: 'P1',
            instructions: '你是 P1',
            modelId: 'mock',
            defaultOptions: { maxTokens: 16384 },
          },
          llmOpts: {},
          agent: p1Agent,
        },
        {
          config: {
            name: 'P2',
            instructions: '你是 P2',
            modelId: 'mock',
            defaultOptions: { maxTokens: 16384 },
          },
          llmOpts: {},
          agent: p2Agent,
        },
      ],
      {
        config: {
          name: 'Agg',
          instructions: '你是聚合器',
          modelId: 'mock',
          defaultOptions: { maxTokens: 16384 },
        },
        llmOpts: {},
        agent: aggAgent,
      },
      bctx,
    )

    const wf: RuntimeWorkflow = {
      executors,
      startExecutor: 'conc',
      edges,
      conditions: new Map(),
      nodes: new Map(),
    }

    const events: StreamEvent[] = []
    await runWorkflow(wf, { text: '问题' }, (e) => events.push(e))

    // 等齐：aggregator 只被调一次，且收到的是 P1+P2 拼接消息
    const aggRun = agentRunOf(executors.get('Agg') as AgentExecutor)
    expect(aggRun).toHaveBeenCalledTimes(1)
    const aggInput = aggRun.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> }
    const joined = aggInput.messages[aggInput.messages.length - 1].content
    expect(joined).toContain('【P1】')
    expect(joined).toContain('P1产出')
    expect(joined).toContain('【P2】')
    expect(joined).toContain('P2产出')
  })

  it('ConcurrentExecutor should_respond=false 不 run', async () => {
    const ce = new ConcurrentExecutor('conc', ['P1', 'P2'], 'Agg')
    ce.cache.push({ role: 'user', content: '输入' })
    let yielded = false
    const ctx = {
      send_message: vi.fn(async () => {}),
      yield_output: vi.fn(async () => {
        yielded = true
      }),
      add_event: vi.fn(async () => {}),
      get_source_executor_id: () => 'conc',
    }
    const stream = ce.handle(
      { messages: [{ role: 'user', content: '输入' }], shouldRespond: false },
      ctx as never,
    )
    for await (const _ of stream) {
      void _
    }
    expect(ctx.send_message).not.toHaveBeenCalled()
    expect(yielded).toBe(false)
  })
})
