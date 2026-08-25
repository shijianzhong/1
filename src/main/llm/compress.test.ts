import { beforeEach, describe, expect, it, vi } from 'vitest'

// —— makeCompressFn 单测（§三之三 D + 铁律21）——
// 锁定「默认 provider 跑一次 LLM 压成 ≤300 字摘要」契约：构造客户端的参数、
// stream 的 system prompt 与 maxTokens、text 块提取。mock getClient 不触真实 LLM。

const fakeStream = vi.fn<(arg: any) => any>(async () => ({
  content: [{ type: 'text', text: 'SUMMARY' }],
}))

vi.mock('./retry', () => ({
  getClient: vi.fn(() => ({ stream: fakeStream })),
}))

import { makeCompressFn } from './compress'
import { getClient } from './retry'

describe('makeCompressFn', () => {
  beforeEach(() => {
    fakeStream.mockClear()
  })

  it('用给定凭据构造 client 并提取 text 块作为摘要', async () => {
    const compress = makeCompressFn('m1', 'k', 'u', 'h', 'openai')
    const out = await compress('长会话文本')
    expect(out).toBe('SUMMARY')
    expect(getClient).toHaveBeenCalledWith('m1', { apiKey: 'k', baseURL: 'u', authHeader: 'h', apiFormat: 'openai' })
  })

  it('stream 使用「摘要助手」system 与 maxTokens 1024，且透传输入文本', async () => {
    const compress = makeCompressFn('m1')
    await compress('原始对话')
    expect(fakeStream).toHaveBeenCalledTimes(1)
    const arg = fakeStream.mock.calls[0][0]
    expect(arg.model).toBe('m1')
    expect(arg.system).toContain('摘要助手')
    expect(arg.maxTokens).toBe(1024)
    expect(arg.messages[0].content).toBe('原始对话')
  })

  it('无 text 块时返回空串（降级）', async () => {
    fakeStream.mockImplementationOnce(async () => ({ content: [{ type: 'tool_use', name: 'x', input: {} }] }))
    const compress = makeCompressFn('m1')
    expect(await compress('x')).toBe('')
  })
})
