import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { APIError, AnthropicError, AuthenticationError, BadRequestError } from '@anthropic-ai/sdk'
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

  it('OpenAI 适配器 Error.status=503 可重试', async () => {
    const err = new Error('OpenAI API 503: unavailable') as Error & { status?: number }
    err.status = 503
    const stream = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce(mockResponse())
    const client = new RetryingClient(makeClient((req) => stream()))

    const p = client.stream(mockReq())
    await vi.advanceTimersToNextTimerAsync()
    const res = await p

    expect(stream).toHaveBeenCalledTimes(2)
    expect(res.stopReason).toBe('end_turn')
  })

  it('OpenAI 适配器 Error.status=401 不重试', async () => {
    const err = new Error('OpenAI API 401: bad key') as Error & { status?: number }
    err.status = 401
    const stream = vi.fn().mockRejectedValue(err)
    const client = new RetryingClient(makeClient((req) => stream()))

    await expect(client.stream(mockReq())).rejects.toThrow('OpenAI API 401')
    expect(stream).toHaveBeenCalledTimes(1)
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

  // —— 模型吐畸形 tool input JSON（铁律11 精神延伸）——
  // SDK 流式累积 tool input 解析失败抛裸 AnthropicError（无 status，非 APIError 子类）。
  // 旧逻辑所有分支都 miss → 不重试 → 崩整个 chat。改为特征串匹配后可重试。
  it('toolInputParseError 可重试（裸 AnthropicError 特征串匹配）', async () => {
    const parseErr = new AnthropicError(
      'Unable to parse tool parameter JSON from model. Please retry your request or adjust your prompt. ' +
        'Error: SyntaxError: Expected double-quoted property name in JSON at position 565. ' +
        'JSON: {"name":"x","graph":{"nodes":[{"data":{"sequential":true}]}}',
    )
    const stream = vi
      .fn()
      .mockRejectedValueOnce(parseErr)
      .mockResolvedValueOnce(mockResponse())
    const client = new RetryingClient(makeClient((req) => stream()))

    const p = client.stream(mockReq())
    await vi.advanceTimersToNextTimerAsync()
    const res = await p

    expect(stream).toHaveBeenCalledTimes(2)
    expect(res.stopReason).toBe('end_turn')
  })

  it('非 toolInputParseError 的裸 AnthropicError 仍不重试（避免过度重试）', async () => {
    // 其他裸 AnthropicError（无特征串）保持不重试，防止把未知 SDK 错误也拉进重试
    const stream = vi
      .fn()
      .mockRejectedValue(new AnthropicError('some other SDK error'))
    const client = new RetryingClient(makeClient((req) => stream()))

    await expect(client.stream(mockReq())).rejects.toThrow('some other SDK error')
    expect(stream).toHaveBeenCalledTimes(1)
  })
})
