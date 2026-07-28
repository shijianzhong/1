import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { APIError, AuthenticationError, BadRequestError } from '@anthropic-ai/sdk'
import type { LlmRequest, LlmResponse } from '@shared/types'
import { RetryingClient } from './retry'
import { LLMClient } from './client'

// —— 重试层单测（§10.1 + §三之三 H）——

function mockReq(): LlmRequest {
  return {
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 16,
  }
}

function mockResponse(): LlmResponse {
  return { stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }
}

function makeClient(streamImpl: (req: LlmRequest) => Promise<LlmResponse>): LLMClient {
  // 注入 mock stream；绕过真实 SDK 调用
  const client = { stream: streamImpl } as unknown as LLMClient
  return client
}

describe('RetryingClient', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('429 重试 3 次后成功', async () => {
    const stream = vi
      .fn()
      .mockRejectedValueOnce(new APIError(429, {}, 'rate limited', new Headers()))
      .mockRejectedValueOnce(new APIError(429, {}, 'rate limited', new Headers()))
      .mockResolvedValueOnce(mockResponse())
    const client = new RetryingClient(makeClient((req) => stream()))

    // 跳过退避
    const p = client.stream(mockReq())
    await vi.advanceTimersToNextTimerAsync()
    await vi.advanceTimersToNextTimerAsync()
    const res = await p

    expect(stream).toHaveBeenCalledTimes(3)
    expect(res.stopReason).toBe('end_turn')
  })

  it('401 不重试，直接抛', async () => {
    const stream = vi
      .fn()
      .mockRejectedValue(new AuthenticationError(401, {}, 'bad key', new Headers()))
    const client = new RetryingClient(makeClient((req) => stream()))

    await expect(client.stream(mockReq())).rejects.toThrow()
    expect(stream).toHaveBeenCalledTimes(1)
  })

  it('400 BadRequest 不重试', async () => {
    const stream = vi
      .fn()
      .mockRejectedValue(new BadRequestError(400, {}, 'bad request', new Headers()))
    const client = new RetryingClient(makeClient((req) => stream()))

    await expect(client.stream(mockReq())).rejects.toThrow()
    expect(stream).toHaveBeenCalledTimes(1)
  })

  it('5xx 重试', async () => {
    const stream = vi
      .fn()
      .mockRejectedValueOnce(new APIError(503, {}, 'unavailable', new Headers()))
      .mockResolvedValueOnce(mockResponse())
    const client = new RetryingClient(makeClient((req) => stream()))

    const p = client.stream(mockReq())
    await vi.advanceTimersToNextTimerAsync()
    const res = await p

    expect(stream).toHaveBeenCalledTimes(2)
    expect(res.stopReason).toBe('end_turn')
  })

  it('网络异常重试（关键词识别）', async () => {
    const stream = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed: network error'))
      .mockResolvedValueOnce(mockResponse())
    const client = new RetryingClient(makeClient((req) => stream()))

    const p = client.stream(mockReq())
    await vi.advanceTimersToNextTimerAsync()
    const res = await p

    expect(stream).toHaveBeenCalledTimes(2)
    expect(res.stopReason).toBe('end_turn')
  })

  it('未知错误不重试', async () => {
    const stream = vi
      .fn()
      .mockRejectedValue(new Error('something broke'))
    const client = new RetryingClient(makeClient((req) => stream()))

    await expect(client.stream(mockReq())).rejects.toThrow('something broke')
    expect(stream).toHaveBeenCalledTimes(1)
  })
})
