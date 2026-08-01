import { describe, expect, it, vi } from 'vitest'
import type {
  AgentConfig,
  AgentRunCallbacks,
  AgentRunInput,
  StreamEvent,
} from '@shared/types'
import { Agent } from '../agent'
import { AgentExecutor } from './agent'
import { runWorkflow } from '../runner'
import type { RuntimeWorkflow } from '../models'

// —— Sequential 黄金用例（§三 E + §三之三 G）——
// mock Agent.run 返回固定文本，验证接力/wake_on_upstream/strip_tool/事件序列。
// 对照原 builder.py 行为（§三 E 迁移纪律）。

function mockAgent(name: string, responseText: string): Agent {
  const config: AgentConfig = {
    name,
    instructions: `你是 ${name}`,
    modelId: 'mock',
    defaultOptions: { maxTokens: 16384 },
  }
  const agent = {
    config,
    deps: {},
    run: vi.fn(async (input: AgentRunInput, _cb: AgentRunCallbacks) => {
      // 把输入最后一条 user 拼到响应，验证接力
      const lastUser = [...input.messages].reverse().find((m) => m.role === 'user')
      const text = `${responseText}（收到: ${typeof lastUser?.content === 'string' ? lastUser.content.slice(0, 20) : ''}）`
      return { messages: input.messages, finalText: text }
    }),
  } as unknown as Agent
  return agent
}

/** 访问 AgentExecutor 的私有 agent.run（测试用） */
function agentRunOf(ex: AgentExecutor): ReturnType<typeof vi.fn> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (ex as unknown as { agent: { run: ReturnType<typeof vi.fn> } }).agent.run
}

function buildSequentialWorkflow(
  names: string[],
  responses: string[],
): RuntimeWorkflow {
  const executors = new Map()
  const ids = names
  for (let i = 0; i < names.length; i++) {
    const ex = new AgentExecutor({
      config: {
        name: names[i],
        instructions: `你是 ${names[i]}`,
        modelId: 'mock',
        defaultOptions: { maxTokens: 16384 },
      },
      llmOpts: {},
      agent: mockAgent(names[i], responses[i]),
    })
    executors.set(names[i], ex)
  }

  const edges = new Map<string, string[]>()
  for (let i = 0; i < ids.length - 1; i++) {
    const list = edges.get(ids[i]) ?? []
    list.push(ids[i + 1])
    edges.set(ids[i], list)
  }

  return {
    executors,
    startExecutor: ids[0],
    edges,
    conditions: new Map(),
    nodes: new Map(),
  }
}

describe('Sequential 黄金用例', () => {
  it('接力：A→B 依次执行，下游收到上游产出', async () => {
    const wf = buildSequentialWorkflow(['A', 'B'], ['A的产出', 'B的产出'])
    const events: StreamEvent[] = []
    const result = await runWorkflow(wf, { text: '开始' }, (e) => events.push(e))

    // 两个 executor 都应被调用
    const aEx = wf.executors.get('A') as AgentExecutor
    const bEx = wf.executors.get('B') as AgentExecutor
    expect(agentRunOf(aEx)).toHaveBeenCalled()
    expect(agentRunOf(bEx)).toHaveBeenCalled()

    // B 收到 A 的产出（接力）
    const bRunCall = agentRunOf(bEx).mock.calls[0][0]
    const bInput = bRunCall.messages as { role: string; content: string }[]
    expect(bInput.some((m) => m.content.includes('A的产出'))).toBe(true)

    // output 事件（terminal 最后）
    const outputs = events.filter((e) => e.type === 'output')
    expect(outputs.length).toBeGreaterThan(0)
    expect(result.output).toContain('B的产出')
  })

  it('单 agent：直接产出', async () => {
    const wf = buildSequentialWorkflow(['Solo'], ['单点输出'])
    const events: StreamEvent[] = []
    const result = await runWorkflow(wf, { text: '问' }, (e) => events.push(e))

    expect(result.output).toContain('单点输出')
    const dones = events.filter((e) => e.type === 'done')
    expect(dones.length).toBe(1)
  })

  it('wake_on_upstream：末条 assistant 非自己时追加 user 唤醒', async () => {
    // 构造 B 的 cache 已有 A 的 assistant 产出（author=A≠B）
    const wf = buildSequentialWorkflow(['A', 'B'], ['A产出', 'B产出'])
    const bEx = wf.executors.get('B') as AgentExecutor
    // 预置 cache：A 的 assistant 消息
    bEx.cache.push({ role: 'assistant', author: 'A', content: 'A产出' })

    await runWorkflow(wf, { text: '开始' }, () => {})

    const bRunCall = agentRunOf(bEx).mock.calls[0][0]
    const bInput = bRunCall.messages as { role: string; content: string }[]
    // 末条应是 user 唤醒指令
    const last = bInput[bInput.length - 1]
    expect(last.role).toBe('user')
    expect(last.content).toContain('继续')
  })

  it('strip_tool_blocks：tool 块被过滤（治 2013）', async () => {
    const wf = buildSequentialWorkflow(['A', 'B'], ['A产出', 'B产出'])
    const bEx = wf.executors.get('B') as AgentExecutor
    // 预置 cache 含 tool 块
    bEx.cache.push({ role: 'tool', content: 'tool_result_1', isFunctionResult: true })
    bEx.cache.push({ role: 'user', content: '正常消息' })

    await runWorkflow(wf, { text: '开始' }, () => {})

    const bRunCall = agentRunOf(bEx).mock.calls[0][0]
    const bInput = bRunCall.messages as { role: string; content: string }[]
    // tool 块被剥
    expect(bInput.some((m) => m.content === 'tool_result_1')).toBe(false)
    // 正常消息保留（full_conversation 转发下同角色连续消息会合并，用 includes 断言）
    expect(bInput.some((m) => m.content.includes('正常消息'))).toBe(true)
  })
})
