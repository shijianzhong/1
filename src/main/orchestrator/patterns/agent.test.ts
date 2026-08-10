import { describe, expect, it, vi } from 'vitest'
import type { OrchMessage } from '@shared/types'
import { AgentExecutor } from './agent'
import type { AgentExecutorOptions } from './agent'
import type { Agent } from '../agent'
import type { LLMClientOptions } from '../../llm/client'
import { repairToolPairs } from '../constraints'

// —— Task 8a：AgentExecutor cache 写入 tool 轨迹 ——
// mock Agent.run 触发 onToolCall/onToolResult，断言 cache 含带 toolUseId 的条目且配对正确

function makeMockAgent(triggerCallbacks: boolean): Agent {
  return {
    config: {
      name: 'test-agent',
      instructions: '',
      modelId: 'fake',
      tools: [{ name: 'grep', description: '', input_schema: {} }],
      defaultOptions: { maxTokens: 1024 },
    },
    deps: { llmOpts: {} },
    run: vi.fn(async (_input, callbacks) => {
      if (triggerCallbacks) {
        callbacks.onToolCall?.('grep', { pattern: 'foo' }, 'tu_1')
        callbacks.onToolResult?.('grep', '{"ok":true,"files":[]}', 'tu_1')
        callbacks.onToolCall?.('glob', { pattern: '*.ts' }, 'tu_2')
        callbacks.onToolResult?.('glob', '{"ok":true,"files":["a.ts"]}', 'tu_2')
      }
      return {
        messages: [],
        finalText: 'done',
        finalThinking: '',
        hitIterationLimit: false,
      }
    }),
  } as unknown as Agent
}

function makeCtx(): { sent: unknown[]; events: unknown[] } & {
  send_message: (d: unknown, t?: string) => Promise<void>
  yield_output: (d: unknown) => Promise<void>
  add_event: (e: unknown) => Promise<void>
  get_source_executor_id: () => string
} {
  const sent: unknown[] = []
  const events: unknown[] = []
  return {
    sent,
    events,
    send_message: async (d, t) => { sent.push({ d, t }) },
    yield_output: async (d) => { events.push({ type: 'output', d }) },
    add_event: async (e) => { events.push(e) },
    get_source_executor_id: () => 'test-agent',
  }
}

describe('AgentExecutor cache 写入 tool 轨迹（Task 8a）', () => {
  const baseOpts = (agent: Agent): AgentExecutorOptions => ({
    config: {
      name: 'test-agent',
      instructions: '',
      modelId: 'fake',
      tools: [{ name: 'grep', description: '', input_schema: {} }],
      defaultOptions: { maxTokens: 1024 },
    },
    llmOpts: {} as LLMClientOptions,
    agent,
  })

  it('onToolCall / onToolResult 写入 cache（带 toolUseId）', async () => {
    const agent = makeMockAgent(true)
    const ex = new AgentExecutor(baseOpts(agent))
    const ctx = makeCtx()

    const gen = ex.handle(
      { messages: [{ role: 'user', content: 'start' }], shouldRespond: true },
      ctx,
    )
    for await (const _ of gen) { /* drain */ }

    const toolUseMsg = ex.cache.find((m) => m.toolUseId === 'tu_1' && !m.isFunctionResult)
    const toolResultMsg = ex.cache.find((m) => m.toolUseId === 'tu_1' && m.isFunctionResult)
    expect(toolUseMsg).toBeDefined()
    expect(toolUseMsg?.role).toBe('assistant')
    expect(toolUseMsg?.content).toBe('[tool:grep]')
    // C1：toolUseName / toolUseInput 也写入 cache（供 assembleMessages 重建真 tool_use block）
    expect(toolUseMsg?.toolUseName).toBe('grep')
    expect(toolUseMsg?.toolUseInput).toEqual({ pattern: 'foo' })
    expect(toolResultMsg).toBeDefined()
    expect(toolResultMsg?.role).toBe('user')
    expect(toolResultMsg?.content).toBe('{"ok":true,"files":[]}')
  })

  it('无 tool 调用时 cache 只含输入 + finalText', async () => {
    const agent = makeMockAgent(false)
    const ex = new AgentExecutor(baseOpts(agent))
    const ctx = makeCtx()

    const gen = ex.handle(
      { messages: [{ role: 'user', content: 'start' }], shouldRespond: true },
      ctx,
    )
    for await (const _ of gen) { /* drain */ }

    expect(ex.cache.some((m) => m.toolUseId)).toBe(false)
    expect(ex.cache.some((m) => m.content === 'done')).toBe(true)
  })
})

// —— Task 8b：条件化 assembleMessages ——
// mock Agent.run 捕获入参 messages，断言有 tools 时保留 tool_result、无 tools 时剥除

function makeCaptureAgent(
  captured: { messages?: Array<{ role: string; content: unknown }> },
  withTools: boolean,
): Agent {
  return {
    config: {
      name: 'cap',
      instructions: '',
      modelId: 'fake',
      tools: withTools ? [{ name: 'grep', description: '', input_schema: {} }] : undefined,
      defaultOptions: { maxTokens: 1024 },
    },
    deps: { llmOpts: {} },
    run: vi.fn(async (input) => {
      captured.messages = input.messages as Array<{ role: string; content: unknown }>
      return {
        messages: [],
        finalText: 'done',
        finalThinking: '',
        hitIterationLimit: false,
      }
    }),
  } as unknown as Agent
}

// —— Task 9：编排模式 thinking 转发到事件流 ——
function makeThinkingAgent(): Agent {
  return {
    config: {
      name: 'thinker',
      instructions: '',
      modelId: 'fake',
      defaultOptions: { maxTokens: 1024 },
    },
    deps: { llmOpts: {} },
    run: vi.fn(async (_input, callbacks) => {
      callbacks.onThinking?.('正在思考…')
      callbacks.onText?.('正文')
      return {
        messages: [],
        finalText: 'done',
        finalThinking: '',
        hitIterationLimit: false,
      }
    }),
  } as unknown as Agent
}

describe('AgentExecutor thinking 透传（Task 9）', () => {
  it('onThinking 触发 add_event type=thinking', async () => {
    const agent = makeThinkingAgent()
    const ex = new AgentExecutor({
      config: agent.config,
      llmOpts: {} as LLMClientOptions,
      agent,
    })
    const ctx = makeCtx()
    const gen = ex.handle(
      { messages: [{ role: 'user', content: 'start' }], shouldRespond: true },
      ctx,
    )
    for await (const _ of gen) { /* drain */ }
    const thinkingEvents = ctx.events.filter(
      (e) => (e as { type?: string }).type === 'thinking',
    )
    expect(thinkingEvents.length).toBe(1)
    expect((thinkingEvents[0] as { text?: string }).text).toBe('正在思考…')
  })
})

describe('AgentExecutor assembleMessages（Task 8b）', () => {
  it('有 tools 时重建真 tool_use/tool_result 配对（无孤儿 block）', async () => {
    const captured: { messages?: Array<{ role: string; content: unknown }> } = {}
    const agent = makeCaptureAgent(captured, true)
    const ex = new AgentExecutor({
      config: agent.config,
      llmOpts: {} as LLMClientOptions,
      agent,
    })
    // 预置 cache：tool_use + tool_result 对（含 toolUseName/toolUseInput 供 C1 重建）
    ex.cache.push({ role: 'user', content: '任务' })
    ex.cache.push({ role: 'assistant', author: 'cap', content: '[tool:grep]', toolUseId: 'tu_1', toolUseName: 'grep', toolUseInput: { pattern: 'foo' } })
    ex.cache.push({ role: 'user', content: '结果', toolUseId: 'tu_1', isFunctionResult: true })

    const ctx = makeCtx()
    const gen = ex.handle(
      { messages: [{ role: 'user', content: '触发' }], shouldRespond: true },
      ctx,
    )
    for await (const _ of gen) { /* drain */ }

    // C1 修复：hasTools 时重建真 tool_use block + tool_result block，配对完整
    const toolUseBlocks = (captured.messages ?? []).flatMap((m) =>
      Array.isArray(m.content)
        ? (m.content as Array<{ type: string; id?: string; name?: string }>).filter((b) => b.type === 'tool_use')
        : [],
    )
    const toolResultBlocks = (captured.messages ?? []).flatMap((m) =>
      Array.isArray(m.content)
        ? (m.content as Array<{ type: string; tool_use_id?: string }>).filter((b) => b.type === 'tool_result')
        : [],
    )
    // 产出了真 tool_use block（非全文本）
    expect(toolUseBlocks.map((u) => u.id)).toContain('tu_1')
    // 每个 tool_result 的 tool_use_id 必须有配对的 tool_use block
    for (const b of toolResultBlocks) {
      expect(toolUseBlocks.map((u) => u.id)).toContain(b.tool_use_id)
    }
  })

  it('无 tools 时剥除 tool 块（治 2013）', async () => {
    const captured: { messages?: Array<{ role: string; content: unknown }> } = {}
    const agent = makeCaptureAgent(captured, false)
    const ex = new AgentExecutor({
      config: agent.config,
      llmOpts: {} as LLMClientOptions,
      agent,
    })
    ex.cache.push({ role: 'user', content: '任务' })
    ex.cache.push({ role: 'assistant', author: 'cap', content: '[tool:grep]', toolUseId: 'tu_1', toolUseName: 'grep', toolUseInput: { pattern: 'foo' } })
    ex.cache.push({ role: 'user', content: '结果', toolUseId: 'tu_1', isFunctionResult: true })

    const ctx = makeCtx()
    const gen = ex.handle(
      { messages: [{ role: 'user', content: '触发' }], shouldRespond: true },
      ctx,
    )
    for await (const _ of gen) { /* drain */ }

    const allText = JSON.stringify(captured.messages ?? [])
    // 无 tools：stripToolBlocksFilter 剥 tool_result，tool_use 占位降级为文本
    expect(allText).not.toContain('tool_result')
    expect(allText).not.toContain('tool_use')
    // tool_use 占位文本仍保留（让下游知道上游调了工具）
    expect(allText).toContain('[tool:grep]')
  })
})

// —— Task 4 并行乱序配对回归 ——
// Task 4 并行执行后，onToolResult 按各工具完成时序触发，cache 物理顺序可能为
// tool_use_A → tool_use_B → result_B → result_A（非 A→result_A→B→result_B）。
// repairToolPairs 按 toolUseId 集合匹配（非物理位置），须在乱序下仍正确配对——
// 不降级、不误剥。assembleMessages 用配对后的 source 组装，下游能拿到完整 tool_result。

describe('并行乱序 cache 配对（Task 4 + 8a 交互）', () => {
  it('result 乱序时 repairToolPairs 仍正确配对（不误降级）', () => {
    // 模拟并行乱序：A→B 两个 tool_use，但 B 的 result 先入 cache
    const cache: OrchMessage[] = [
      { role: 'assistant', author: 'A', content: '[tool:grep]', toolUseId: 'tu_A' },
      { role: 'assistant', author: 'A', content: '[tool:glob]', toolUseId: 'tu_B' },
      { role: 'user', author: 'A', content: '{"files":["b"]}', toolUseId: 'tu_B', isFunctionResult: true },
      { role: 'user', author: 'A', content: '{"files":["a"]}', toolUseId: 'tu_A', isFunctionResult: true },
    ]
    const out = repairToolPairs(cache)
    // 两个 tool_use 都有配对 result → 不应降级（toolUseId 保留）
    const useA = out.find((m) => m.toolUseId === 'tu_A' && !m.isFunctionResult)
    const useB = out.find((m) => m.toolUseId === 'tu_B' && !m.isFunctionResult)
    const resA = out.find((m) => m.toolUseId === 'tu_A' && m.isFunctionResult)
    const resB = out.find((m) => m.toolUseId === 'tu_B' && m.isFunctionResult)
    expect(useA?.toolUseId).toBe('tu_A') // 未降级
    expect(useB?.toolUseId).toBe('tu_B')
    expect(resA?.toolUseId).toBe('tu_A') // 未剥
    expect(resB?.toolUseId).toBe('tu_B')
    // 物理乱序保留（repairToolPairs 不重排）
    expect(out[2].toolUseId).toBe('tu_B')
    expect(out[3].toolUseId).toBe('tu_A')
  })

  it('assembleMessages 乱序 cache 配对正确（无孤儿 tool_result）', async () => {
    const captured: { messages?: Array<{ role: string; content: unknown }> } = {}
    const agent = makeCaptureAgent(captured, true)
    const ex = new AgentExecutor({
      config: agent.config,
      llmOpts: {} as LLMClientOptions,
      agent,
    })
    // 预置乱序 cache：tool_use_A → tool_use_B → result_B → result_A
    ex.cache.push({ role: 'user', content: '任务' })
    ex.cache.push({ role: 'assistant', author: 'cap', content: '[tool:grep]', toolUseId: 'tu_A', toolUseName: 'grep', toolUseInput: { pattern: 'a' } })
    ex.cache.push({ role: 'assistant', author: 'cap', content: '[tool:glob]', toolUseId: 'tu_B', toolUseName: 'glob', toolUseInput: { pattern: '*.ts' } })
    ex.cache.push({ role: 'user', content: '{"files":["b"]}', toolUseId: 'tu_B', isFunctionResult: true })
    ex.cache.push({ role: 'user', content: '{"files":["a"]}', toolUseId: 'tu_A', isFunctionResult: true })

    const ctx = makeCtx()
    const gen = ex.handle(
      { messages: [{ role: 'user', content: '触发' }], shouldRespond: true },
      ctx,
    )
    for await (const _ of gen) { /* drain */ }

    // C1 修复后：重建真 tool_use + tool_result block，乱序下配对仍完整
    const toolUseBlocks = (captured.messages ?? []).flatMap((m) =>
      Array.isArray(m.content)
        ? (m.content as Array<{ type: string; id?: string }>).filter((b) => b.type === 'tool_use')
        : [],
    )
    const toolResultBlocks = (captured.messages ?? []).flatMap((m) =>
      Array.isArray(m.content)
        ? (m.content as Array<{ type: string; tool_use_id?: string }>).filter((b) => b.type === 'tool_result')
        : [],
    )
    // 两个 tool_use block 都重建了
    expect(toolUseBlocks.map((u) => u.id).sort()).toEqual(['tu_A', 'tu_B'])
    // 每个 tool_result 都有配对的 tool_use（乱序不影响配对）
    for (const b of toolResultBlocks) {
      expect(toolUseBlocks.map((u) => u.id)).toContain(b.tool_use_id)
    }
  })
})
