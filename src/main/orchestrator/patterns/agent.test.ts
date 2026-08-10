import { describe, expect, it, vi } from 'vitest'
import type { OrchMessage } from '@shared/types'
import { AgentExecutor } from './agent'
import type { AgentExecutorOptions } from './agent'
import type { Agent } from '../agent'
import type { LLMClientOptions } from '../../llm/client'

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

describe('AgentExecutor assembleMessages（Task 8b）', () => {
  it('有 tools 时保留 tool_result 块配对', async () => {
    const captured: { messages?: Array<{ role: string; content: unknown }> } = {}
    const agent = makeCaptureAgent(captured, true)
    const ex = new AgentExecutor({
      config: agent.config,
      llmOpts: {} as LLMClientOptions,
      agent,
    })
    // 预置 cache：tool_use + tool_result 对
    ex.cache.push({ role: 'user', content: '任务' })
    ex.cache.push({ role: 'assistant', author: 'cap', content: '[tool:grep]', toolUseId: 'tu_1' })
    ex.cache.push({ role: 'user', content: '结果', toolUseId: 'tu_1', isFunctionResult: true })

    const ctx = makeCtx()
    const gen = ex.handle(
      { messages: [{ role: 'user', content: '触发' }], shouldRespond: true },
      ctx,
    )
    for await (const _ of gen) { /* drain */ }

    const userMsgs = (captured.messages ?? []).filter((m) => m.role === 'user')
    const hasToolResultBlock = userMsgs.some((m) =>
      Array.isArray(m.content) &&
      (m.content as Array<{ type: string }>).some((b) => b.type === 'tool_result'),
    )
    expect(hasToolResultBlock).toBe(true)
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
    ex.cache.push({ role: 'assistant', author: 'cap', content: '[tool:grep]', toolUseId: 'tu_1' })
    ex.cache.push({ role: 'user', content: '结果', toolUseId: 'tu_1', isFunctionResult: true })

    const ctx = makeCtx()
    const gen = ex.handle(
      { messages: [{ role: 'user', content: '触发' }], shouldRespond: true },
      ctx,
    )
    for await (const _ of gen) { /* drain */ }

    const allText = JSON.stringify(captured.messages ?? [])
    expect(allText).not.toContain('tool_result')
    // 无 tools 时 tool_use 占位文本仍保留（让下游知道上游调了工具）
    expect(allText).toContain('[tool:grep]')
  })
})
