import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { LlmRequest, LlmResponse } from '@shared/types'
import { Agent } from './agent'

// —— maxIterations 触顶收尾：不能静默停在半截 tool_use ——

const streamMock = vi.fn<(req: LlmRequest) => Promise<LlmResponse>>()

vi.mock('../llm/retry', () => ({
  getClient: () => ({ stream: (req: LlmRequest) => streamMock(req) }),
}))

vi.mock('../tools/registry', () => ({
  executeTool: vi.fn(async (_name: string, _args: unknown, id: string) => ({
    toolUseId: id,
    content: JSON.stringify({ ok: true }),
    isError: false,
  })),
  getToolDefs: () => [],
}))

function toolUseTurn(text: string, callId: string): LlmResponse {
  return {
    stopReason: 'tool_use',
    content: [
      ...(text ? [{ type: 'text' as const, text }] : []),
      { type: 'tool_use' as const, id: callId, name: 'web_search', input: { q: 'x' } },
    ],
  }
}

describe('Agent maxIterations 收尾', () => {
  beforeEach(() => {
    streamMock.mockReset()
  })

  it('触顶且最后一轮仍是 tool_use → 再打一轮无工具收尾，不把半截话当终局', async () => {
    // 2 轮 tool_use + 1 轮强制收尾
    streamMock
      .mockResolvedValueOnce(toolUseTurn('先查一下…', 'tu_0'))
      .mockResolvedValueOnce(toolUseTurn('继续查…', 'tu_1'))
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        content: [{ type: 'text', text: '根据已有结果，结论是这样。' }],
      })

    const agent = new Agent(
      {
        name: 'home',
        instructions: '助手',
        modelId: 'fake',
        tools: [{ name: 'web_search', description: 's', input_schema: { type: 'object' } }],
        defaultOptions: { maxTokens: 1024 },
      },
      { llmOpts: {} },
    )

    const result = await agent.run(
      { messages: [{ role: 'user', content: '调研一下' }] },
      {},
      { maxIterations: 2 },
    )

    expect(streamMock).toHaveBeenCalledTimes(3)
    // 收尾轮不得再挂 tools
    const finalReq = streamMock.mock.calls[2][0]
    expect(finalReq.tools).toBeUndefined()
    expect(result.finalText).toBe('根据已有结果，结论是这样。')
    expect(result.hitIterationLimit).toBe(true)
  })

  it('正常 end_turn 提前结束 → 不额外收尾轮，hitIterationLimit=false', async () => {
    streamMock.mockResolvedValueOnce({
      stopReason: 'end_turn',
      content: [{ type: 'text', text: '直接答完' }],
    })

    const agent = new Agent(
      {
        name: 'a',
        instructions: 'x',
        modelId: 'fake',
        defaultOptions: { maxTokens: 1024 },
      },
      { llmOpts: {} },
    )

    const result = await agent.run(
      { messages: [{ role: 'user', content: 'hi' }] },
      {},
      { maxIterations: 2 },
    )

    expect(streamMock).toHaveBeenCalledTimes(1)
    expect(result.finalText).toBe('直接答完')
    expect(result.hitIterationLimit).toBe(false)
  })
})
