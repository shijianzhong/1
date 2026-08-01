import { describe, expect, it, vi } from 'vitest'
import type { LlmResponse } from '@shared/types'
import { Agent, injectRuntimeContext } from './agent'

// —— Agent 单测（mock 最底层 LLM client）——

const capturedSystems: string[] = []

vi.mock('../llm/retry', () => ({
  getClient: () => ({
    async stream(req: { system: string }): Promise<LlmResponse> {
      capturedSystems.push(req.system)
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }
    },
  }),
}))

describe('injectRuntimeContext', () => {
  it('在原 instructions 末尾追加当前时间 + 时区', () => {
    const out = injectRuntimeContext('你是助手')
    expect(out.startsWith('你是助手')).toBe(true)
    expect(out).toContain('<runtime_context>')
    // 本地时间格式 YYYY-MM-DD HH:mm
    expect(out).toMatch(/当前时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
    // 时区格式 UTC±H 或 UTC±H:MM
    expect(out).toMatch(/UTC[+-]\d{1,2}(:\d{2})?/)
  })

  it('Agent.run 把注入后的 system 传给 LLM（首页/编排/GroupChat manager 统一覆盖）', async () => {
    capturedSystems.length = 0
    const agent = new Agent(
      {
        name: 'a',
        instructions: '原始指令',
        modelId: 'fake',
        defaultOptions: { maxTokens: 1024 },
      },
      { llmOpts: {} },
    )
    await agent.run({ messages: [{ role: 'user', content: 'hi' }] })
    expect(capturedSystems).toHaveLength(1)
    expect(capturedSystems[0]).toContain('原始指令')
    expect(capturedSystems[0]).toContain('当前时间：')
  })
})
