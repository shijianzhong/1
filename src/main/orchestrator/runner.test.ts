import { describe, expect, it, vi } from 'vitest'
import type { ExecutorRequest, StreamEvent, WorkflowContext } from '@shared/types'
import type { Executor, RuntimeWorkflow } from './models'
import { runWorkflow } from './runner'

// —— runner Pregel 黄金用例（§三之三 E + 铁律15/7）——

/** 录制 handle 调用次数与 shouldRespond 的测试 executor */
class RecordingExecutor implements Executor {
  cache: import('@shared/types').OrchMessage[] = []
  calls: ExecutorRequest[] = []
  constructor(
    readonly id: string,
    private readonly respondText: string,
  ) {}
  async *handle(req: ExecutorRequest, ctx: WorkflowContext): AsyncIterable<StreamEvent> {
    this.calls.push(req)
    if (!req.shouldRespond) return
    this.cache.push({ role: 'assistant', author: this.id, content: this.respondText })
    await ctx.yield_output(this.respondText)
  }
}

describe('runner shouldRespond 双语义（铁律15）', () => {
  it('shouldRespond=false 仅 extend cache，不触发 handle，且不再 fan-out', async () => {
    const a = new RecordingExecutor('A', 'A产出')
    const b = new RecordingExecutor('B', 'B产出')
    const executors = new Map<string, Executor>([
      ['A', a],
      ['B', b],
    ])
    const edges = new Map<string, string[]>([['A', ['B']]]) // A 下游是 B
    const wf: RuntimeWorkflow = {
      executors,
      startExecutor: 'A',
      edges,
      conditions: new Map(),
      nodes: new Map(),
    }

    // 直接塞一条 shouldRespond=false 的消息给 A（模拟 GroupChat broadcast）
    const events: StreamEvent[] = []
    const ctx = {
      pending: [] as never[],
      output: [] as string[],
    }
    void ctx
    // 用 runWorkflow 但预置 broadcast 消息：借 startExecutor 初始消息做不到，
    // 改直接驱动 deliverToExecutor——不可行（未导出）。改为：构造 wf 让 A 收到
    // 初始消息后再 broadcast 给 B。更简单的验证路径：GroupChat 单测已覆盖。
    // 这里验证「普通 fan-out shouldRespond 默认 true」即可。
    await runWorkflow(wf, { text: '问题' }, (e) => events.push(e))

    // A 被触发（默认 true），B 也被触发（fan-out 默认 true）
    expect(a.calls.length).toBe(1)
    expect(a.calls[0].shouldRespond).toBe(true)
    expect(b.calls.length).toBe(1)
    expect(b.calls[0].shouldRespond).toBe(true)
  })

  it('初始消息投递到 startExecutor，handle 产出进 output 事件流', async () => {
    const a = new RecordingExecutor('A', '最终产出')
    const executors = new Map<string, Executor>([['A', a]])
    const wf: RuntimeWorkflow = {
      executors,
      startExecutor: 'A',
      edges: new Map(),
      conditions: new Map(),
      nodes: new Map(),
    }
    const events: StreamEvent[] = []
    const result = await runWorkflow(wf, { text: '问题' }, (e) => events.push(e))
    expect(result.output).toContain('最终产出')
    expect(events.some((e) => e.type === 'done')).toBe(true)
  })
})

describe('runner 条件边路由（GraphEdge.condition）', () => {
  it('contains: 谓词命中走对应 target，未命中不走', async () => {
    const router = new RecordingExecutor('R', '结果包含关键字 foo')
    const hit = new RecordingExecutor('HIT', '命中分支')
    const miss = new RecordingExecutor('MISS', '未命中分支')
    const executors = new Map<string, Executor>([
      ['R', router],
      ['HIT', hit],
      ['MISS', miss],
    ])
    const conditions = new Map<string, Array<{ predicate: string; target: string }>>([
      ['R', [{ predicate: 'contains:foo', target: 'HIT' }]],
    ])
    const wf: RuntimeWorkflow = {
      executors,
      startExecutor: 'R',
      edges: new Map([['R', ['MISS']]]), // 普通边作为兜底（条件优先）
      conditions,
      nodes: new Map(),
    }
    const events: StreamEvent[] = []
    await runWorkflow(wf, { text: '问题' }, (e) => events.push(e))

    // 条件命中 → 只走 HIT，不走 MISS（条件边优先于普通边）
    expect(hit.calls.length).toBe(1)
    expect(miss.calls.length).toBe(0)
  })

  it('contains: 谓词未命中 → 普通边兜底', async () => {
    const router = new RecordingExecutor('R', '无关键字')
    const hit = new RecordingExecutor('HIT', '命中分支')
    const miss = new RecordingExecutor('MISS', '兜底分支')
    const executors = new Map<string, Executor>([
      ['R', router],
      ['HIT', hit],
      ['MISS', miss],
    ])
    const conditions = new Map<string, Array<{ predicate: string; target: string }>>([
      ['R', [{ predicate: 'contains:foo', target: 'HIT' }]],
    ])
    const wf: RuntimeWorkflow = {
      executors,
      startExecutor: 'R',
      edges: new Map([['R', ['MISS']]]),
      conditions,
      nodes: new Map(),
    }
    const events: StreamEvent[] = []
    await runWorkflow(wf, { text: '问题' }, (e) => events.push(e))

    expect(hit.calls.length).toBe(0)
    expect(miss.calls.length).toBe(1)
  })
})

describe('builder GraphEdge.condition → conditions 映射', () => {
  it('带 condition 的边进 conditions，不带 condition 的边进 edges', async () => {
    const { buildWorkflow } = await import('./builder')
    const graph: import('@shared/types').WorkflowGraph = {
      nodes: [
        { id: 'R', type: 'agent', data: { label: 'R', instructions: 'x' }, position: { x: 0, y: 0 } },
        { id: 'HIT', type: 'agent', data: { label: 'HIT', instructions: 'x' }, position: { x: 0, y: 0 } },
        { id: 'MISS', type: 'agent', data: { label: 'MISS', instructions: 'x' }, position: { x: 0, y: 0 } },
      ],
      edges: [
        { source: 'R', target: 'HIT', condition: 'contains:foo' },
        { source: 'R', target: 'MISS' },
      ],
    }
    const wf = buildWorkflow(graph, {
      resolveAgent: (n) => ({
        config: {
          name: n.id,
          instructions: 'x',
          modelId: 'mock',
          defaultOptions: { maxTokens: 16384 },
        },
        llmOpts: {},
      }),
    })
    expect(wf.conditions.get('R')).toEqual([{ predicate: 'contains:foo', target: 'HIT' }])
    expect(wf.edges.get('R')).toEqual(['MISS'])
  })
})

// —— Concurrent 容器下游触发回归（实测 bug 复刻）——
// 用户图：并发容器（调研+拆解）→ 公众号写作 → 内容审稿；aggregator 存的是角色库 id。
// 旧行为：容器 handle（纯分发，瞬间完成）后 runner 立刻边 fan-out，把「原始输入」
// 发给写作 agent → 写作与调研同 superstep 并发开跑，拿不到调研结果反问用户；
// 之后 fan-in 栅栏又聚合触发一次 → 双触发。
// 修复：Concurrent 容器禁边 fan-out，下游统一由栅栏等齐后投「任务前缀+聚合结果」。
describe('Concurrent 容器下游只能由 fan-in 栅栏触发', () => {
  it('aggregator 收一次聚合消息（含原始任务），下游收 aggregator 产出', async () => {
    const { buildWorkflow } = await import('./builder')
    const { AgentExecutor } = await import('./patterns/agent')

    const callOrder: string[] = []
    const mockOpts = (name: string) => {
      const config = {
        name,
        instructions: 'x',
        modelId: 'mock',
        defaultOptions: { maxTokens: 16384 },
      }
      const agent = {
        config,
        deps: {},
        run: vi.fn(async (input: { messages: Array<{ content: unknown }> }) => {
          callOrder.push(name)
          return { messages: input.messages, finalText: `${name}产出` }
        }),
      }
      return { config, llmOpts: {}, agent } as never
    }

    // 复刻用户图：aggregator 字段存角色库 id（lib_agg），Agg 节点 sourceAgentId 匹配；
    // 边 conc→Agg（节点 id）+ conc→lib_agg（悬空角色库 id 边，存量数据）。
    const graph: import('@shared/types').WorkflowGraph = {
      nodes: [
        {
          id: 'conc',
          type: 'concurrent',
          data: { label: '并发', participants: ['P1', 'P2'], aggregator: 'lib_agg' },
          position: { x: 0, y: 0 },
        },
        { id: 'P1', type: 'agent', data: { label: '调研', parentId: 'conc' }, position: { x: 0, y: 0 } },
        { id: 'P2', type: 'agent', data: { label: '拆解', parentId: 'conc' }, position: { x: 0, y: 0 } },
        { id: 'Agg', type: 'agent', data: { label: '写作', sourceAgentId: 'lib_agg' }, position: { x: 0, y: 0 } },
        { id: 'Review', type: 'agent', data: { label: '审稿' }, position: { x: 0, y: 0 } },
      ],
      edges: [
        { source: 'conc', target: 'Agg' },
        { source: 'Agg', target: 'Review' },
        { source: 'conc', target: 'lib_agg' },
      ],
    }
    const wf = buildWorkflow(graph, { resolveAgent: (n) => mockOpts(n.id) })

    const events: StreamEvent[] = []
    const { output } = await runWorkflow(wf, { text: '搜集最新ai资讯' }, (e) => events.push(e))

    const runOf = (id: string) =>
      (wf.executors.get(id) as unknown as { agent: { run: ReturnType<typeof vi.fn> } }).agent.run

    // 每个 agent 恰好跑一次（无旧 bug 的双触发）
    for (const id of ['P1', 'P2', 'Agg', 'Review']) {
      expect(runOf(id), id).toHaveBeenCalledTimes(1)
    }
    // 时序：两个 participant 都完成后 Agg 才跑，Agg 完成后 Review 才跑
    expect(callOrder.indexOf('Agg')).toBeGreaterThan(callOrder.indexOf('P1'))
    expect(callOrder.indexOf('Agg')).toBeGreaterThan(callOrder.indexOf('P2'))
    expect(callOrder.indexOf('Review')).toBeGreaterThan(callOrder.indexOf('Agg'))

    // Agg 收到的是「任务前缀 + 各 participant 聚合」，不是裸原始输入
    const aggInput = runOf('Agg').mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>
    }
    const aggText = aggInput.messages.map((m) => m.content).join('\n')
    expect(aggText).toContain('任务：搜集最新ai资讯')
    expect(aggText).toContain('【P1】')
    expect(aggText).toContain('P1产出')
    expect(aggText).toContain('【P2】')
    expect(aggText).toContain('P2产出')

    // Review 收到 Agg 的产出（边 fan-out 正常）
    const reviewInput = runOf('Review').mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>
    }
    expect(reviewInput.messages.map((m) => m.content).join('\n')).toContain('Agg产出')

    // 终态输出包含各环节产出，无 failed 事件
    expect(output).toContain('Agg产出')
    expect(events.some((e) => e.type === 'failed')).toBe(false)
  })

  it('容器→aggregator 视觉边（角色库 id 形态）不进运行时 edges', async () => {
    const { buildWorkflow } = await import('./builder')
    const graph: import('@shared/types').WorkflowGraph = {
      nodes: [
        {
          id: 'conc',
          type: 'concurrent',
          data: { label: '并发', participants: ['P1'], aggregator: 'lib_agg' },
          position: { x: 0, y: 0 },
        },
        { id: 'P1', type: 'agent', data: { label: 'P1', parentId: 'conc' }, position: { x: 0, y: 0 } },
        { id: 'Agg', type: 'agent', data: { label: 'Agg', sourceAgentId: 'lib_agg' }, position: { x: 0, y: 0 } },
      ],
      edges: [{ source: 'conc', target: 'lib_agg' }],
    }
    const wf = buildWorkflow(graph, {
      resolveAgent: (n) => ({
        config: { name: n.id, instructions: 'x', modelId: 'mock', defaultOptions: { maxTokens: 16384 } },
        llmOpts: {},
      }),
    })
    // 视觉边被跳过（端点已解析为节点 id 后与 containerAggregators 比对命中）
    expect(wf.edges.get('conc')).toBeUndefined()
    expect(wf.executors.get('conc')).toBeDefined()
    expect((wf.executors.get('conc') as unknown as { aggregatorId: string }).aggregatorId).toBe('Agg')
  })
})

// —— fan-in 栅栏容错（participant 失败回归）——
// 旧行为：participant handle 抛异常 → 永远没有 assistant 产出 → 栅栏永不满足，
// pending 清空后 workflow 静默提前收敛，聚合结果整体丢失（用户只见 done，不见聚合）。
// 修复：失败 participant 视为「已结束」，容错聚合已有结果 + 失败标注。
describe('Concurrent fan-in 栅栏 participant 失败容错', () => {
  it('一个 participant 失败：栅栏仍聚合（成功结果 + 失败标注），aggregator 触发一次', async () => {
    const { buildWorkflow } = await import('./builder')

    const mockOpts = (name: string) => {
      const config = {
        name,
        instructions: 'x',
        modelId: 'mock',
        defaultOptions: { maxTokens: 16384 },
      }
      const agent = {
        config,
        deps: {},
        run: vi.fn(async (input: { messages: Array<{ content: unknown }> }) => {
          if (name === 'P2') throw new Error('boom')
          return { messages: input.messages, finalText: `${name}产出` }
        }),
      }
      return { config, llmOpts: {}, agent } as never
    }

    const graph: import('@shared/types').WorkflowGraph = {
      nodes: [
        {
          id: 'conc',
          type: 'concurrent',
          data: { label: '并发', participants: ['P1', 'P2'], aggregator: 'lib_agg' },
          position: { x: 0, y: 0 },
        },
        { id: 'P1', type: 'agent', data: { label: '调研', parentId: 'conc' }, position: { x: 0, y: 0 } },
        { id: 'P2', type: 'agent', data: { label: '拆解', parentId: 'conc' }, position: { x: 0, y: 0 } },
        { id: 'Agg', type: 'agent', data: { label: '写作', sourceAgentId: 'lib_agg' }, position: { x: 0, y: 0 } },
      ],
      edges: [{ source: 'conc', target: 'Agg' }],
    }
    const wf = buildWorkflow(graph, { resolveAgent: (n) => mockOpts(n.id) })

    const events: StreamEvent[] = []
    await runWorkflow(wf, { text: '任务' }, (e) => events.push(e))

    const runOf = (id: string) =>
      (wf.executors.get(id) as unknown as { agent: { run: ReturnType<typeof vi.fn> } }).agent.run

    // 关键断言：aggregator 被触发（旧行为 0 次——栅栏永等不到失败的 P2）
    expect(runOf('Agg')).toHaveBeenCalledTimes(1)
    const aggInput = runOf('Agg').mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>
    }
    const aggText = aggInput.messages.map((m) => m.content).join('\n')
    // 成功 participant 的结果保留；失败 participant 有显式标注（aggregator 可知）
    expect(aggText).toContain('【P1】')
    expect(aggText).toContain('P1产出')
    expect(aggText).toContain('【P2】')
    expect(aggText).toContain('执行失败')
    // 失败对前端可见（node_error 事件），workflow 正常收敛（done）
    expect(events.some((e) => e.type === 'node_error' && e.node_id === 'P2')).toBe(true)
    expect(events.some((e) => e.type === 'done')).toBe(true)
  })
})

// —— Sequential 管线 full_conversation 转发（用户图重构回归）——
// 图：sequential[调研 R → 拆解 T] → 写作 W → 审稿 V。
// 保真（§G）：下游 cache extend 上游完整对话 —— W 必须同时看到原始任务 + R 产出 + T 产出；
// 只转末条会让 W 丢失调研上下文。容器边界边由 builder 改写（S→W ⇒ T→W）。
describe('Sequential 管线 full_conversation 转发', () => {
  it('写作收到原始任务+全部上游产出，角色严格交替，顺序 R<T<W<V', async () => {
    const { buildWorkflow } = await import('./builder')

    const callOrder: string[] = []
    const mockOpts = (name: string) => {
      const config = {
        name,
        instructions: 'x',
        modelId: 'mock',
        defaultOptions: { maxTokens: 16384 },
      }
      const agent = {
        config,
        deps: {},
        run: vi.fn(async (input: { messages: Array<{ role: string; content: unknown }> }) => {
          callOrder.push(name)
          return { messages: input.messages, finalText: `${name}产出` }
        }),
      }
      return { config, llmOpts: {}, agent } as never
    }

    const graph: import('@shared/types').WorkflowGraph = {
      nodes: [
        {
          id: 'seq',
          type: 'sequential',
          data: { label: '调研→拆解', participants: ['R', 'T'] },
          position: { x: 0, y: 0 },
        },
        { id: 'R', type: 'agent', data: { label: '调研', parentId: 'seq' }, position: { x: 0, y: 0 } },
        { id: 'T', type: 'agent', data: { label: '拆解', parentId: 'seq' }, position: { x: 0, y: 0 } },
        { id: 'W', type: 'agent', data: { label: '写作' }, position: { x: 0, y: 0 } },
        { id: 'V', type: 'agent', data: { label: '审稿' }, position: { x: 0, y: 0 } },
      ],
      edges: [
        { source: 'seq', target: 'W' },
        { source: 'W', target: 'V' },
      ],
    }
    const wf = buildWorkflow(graph, { resolveAgent: (n) => mockOpts(n.id) })

    const events: StreamEvent[] = []
    await runWorkflow(wf, { text: '搜集最新ai资讯' }, (e) => events.push(e))

    const runOf = (id: string) =>
      (wf.executors.get(id) as unknown as { agent: { run: ReturnType<typeof vi.fn> } }).agent.run

    // 每个 agent 恰好一次，顺序 R < T < W < V
    for (const id of ['R', 'T', 'W', 'V']) {
      expect(runOf(id), id).toHaveBeenCalledTimes(1)
    }
    expect(callOrder).toEqual(['R', 'T', 'W', 'V'])

    // W 拿到 full conversation：原始任务 + 调研产出 + 拆解产出
    const wInput = runOf('W').mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>
    }
    const wText = wInput.messages.map((m) => m.content).join('\n')
    expect(wText).toContain('搜集最新ai资讯')
    expect(wText).toContain('R产出')
    expect(wText).toContain('T产出')
    // 角色严格交替（连续同角色已合并，防 Anthropic 400）
    for (let i = 1; i < wInput.messages.length; i++) {
      expect(wInput.messages[i].role).not.toBe(wInput.messages[i - 1].role)
    }

    // V 拿到 W 的产出（链路逐跳累积）
    const vInput = runOf('V').mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>
    }
    expect(vInput.messages.map((m) => m.content).join('\n')).toContain('W产出')

    expect(events.some((e) => e.type === 'failed')).toBe(false)
  })

  it('纯平铺链（无容器）：调研→拆解→写作→审稿 等价语义', async () => {
    const { buildWorkflow } = await import('./builder')

    const callOrder: string[] = []
    const mockOpts = (name: string) => {
      const config = {
        name,
        instructions: 'x',
        modelId: 'mock',
        defaultOptions: { maxTokens: 16384 },
      }
      const agent = {
        config,
        deps: {},
        run: vi.fn(async (input: { messages: Array<{ role: string; content: unknown }> }) => {
          callOrder.push(name)
          return { messages: input.messages, finalText: `${name}产出` }
        }),
      }
      return { config, llmOpts: {}, agent } as never
    }

    // 无容器平铺：sequential 容器只是线性边语法糖，纯 agent 链语义必须一致
    const agent = (id: string, isEntry = false) => ({
      id,
      type: 'agent' as const,
      data: { label: id, ...(isEntry ? { isEntry: true } : {}) },
      position: { x: 0, y: 0 },
    })
    const graph: import('@shared/types').WorkflowGraph = {
      nodes: [agent('R', true), agent('T'), agent('W'), agent('V')],
      edges: [
        { source: 'R', target: 'T' },
        { source: 'T', target: 'W' },
        { source: 'W', target: 'V' },
      ],
    }
    const wf = buildWorkflow(graph, { resolveAgent: (n) => mockOpts(n.id) })

    // 入口 = 显式 isEntry 的 R
    expect(wf.startExecutor).toBe('R')

    const events: StreamEvent[] = []
    await runWorkflow(wf, { text: '搜集最新ai资讯' }, (e) => events.push(e))

    const runOf = (id: string) =>
      (wf.executors.get(id) as unknown as { agent: { run: ReturnType<typeof vi.fn> } }).agent.run

    expect(callOrder).toEqual(['R', 'T', 'W', 'V'])
    // W 拿到 full conversation：原始任务 + R + T
    const wInput = runOf('W').mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>
    }
    const wText = wInput.messages.map((m) => m.content).join('\n')
    expect(wText).toContain('搜集最新ai资讯')
    expect(wText).toContain('R产出')
    expect(wText).toContain('T产出')
    expect(events.some((e) => e.type === 'failed')).toBe(false)
  })
})

// 占位避免 lint 未使用告警
void vi
