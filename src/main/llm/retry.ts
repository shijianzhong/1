import { APIError, AuthenticationError, BadRequestError } from '@anthropic-ai/sdk'
import type { LlmRequest, LlmResponse } from '@shared/types'
import { logger } from '../logger'
import { LLMClient, type LLMClientOptions } from './client'

// —— 重试包装层（§三之三 H + 铁律10）——
// 必须包在 LLMClient.stream()（真正调 beta.messages.stream 的方法）外层，
// 否则 429/5xx 重试层被绕过。TS 不像 Python __getattr__ 拦截 5 个方法名，
// 这里直接包 stream 方法（唯一的 LLM 请求出口）。

const MAX_RETRIES = 3
const BASE_DELAYS_MS = [1000, 2000, 4000] // 1s/2s/4s
const JITTER_RATIO = 0.2 // ±20% 防惊群

// 中转网关报错兜底关键词（§三之三 H）
const GATEWAY_RETRY_KEYWORDS = [
  'rate_limit',
  'overloaded',
  'timeout',
  'connection',
  '429',
  'backend returned',
]

function isRetryable(error: unknown): boolean {
  // 401/400/ValidationError 不重试（§三之三 H）
  if (error instanceof AuthenticationError) return false
  if (error instanceof BadRequestError) return false

  // Anthropic APIError：看 status
  if (error instanceof APIError) {
    const status = error.status ?? 0
    return status === 429 || (status >= 500 && status <= 504)
  }

  // 网络异常 / 中转网关报错
  if (error instanceof Error) {
    const name = error.name.toLowerCase()
    const msg = error.message.toLowerCase()
    // name 或 message 任一含网络/超时/中转关键词即重试
    if (/network|fetch|abort|timeout|connection|econn|enotfound/i.test(name)) return true
    if (/network|fetch|abort|timeout|connection|econn|enotfound/i.test(msg)) return true
    return GATEWAY_RETRY_KEYWORDS.some((kw) => msg.includes(kw))
  }
  return false
}

function computeDelay(attempt: number): number {
  const base = BASE_DELAYS_MS[Math.min(attempt, BASE_DELAYS_MS.length - 1)]
  const jitter = base * JITTER_RATIO * (Math.random() * 2 - 1) // ±20%
  return Math.round(base + jitter)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(signal.reason ?? new Error('aborted'))
    })
  })
}

export class RetryingClient {
  private readonly inner: LLMClient

  constructor(clientOrOpts: LLMClient | LLMClientOptions = {}) {
    // duck-type：有 stream 方法即视为已构造的 client（便于测试注入 mock）
    this.inner =
      clientOrOpts && typeof (clientOrOpts as LLMClient).stream === 'function'
        ? (clientOrOpts as LLMClient)
        : new LLMClient(clientOrOpts as LLMClientOptions)
  }

  async stream(req: LlmRequest): Promise<LlmResponse> {
    let lastError: unknown
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        // 取消信号直接抛，不重试
        if (req.signal?.aborted) throw req.signal.reason ?? new Error('aborted')
        return await this.inner.stream(req)
      } catch (error) {
        lastError = error
        if (req.signal?.aborted) throw error
        if (attempt >= MAX_RETRIES || !isRetryable(error)) {
          throw error
        }
        const delay = computeDelay(attempt)
        logger.warn(
          `[llm] 重试 ${attempt + 1}/${MAX_RETRIES}，延迟 ${delay}ms`,
          error instanceof Error ? error.message : error,
        )
        // 通知前端「重试等待中」（429/5xx 等）
        req.onRetry?.({
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES,
          delayMs: delay,
          reason: error instanceof Error ? error.message : String(error),
        })
        await sleep(delay, req.signal)
      }
    }
    throw lastError
  }
}

// —— client 按 modelId 缓存（§三之三 H：@lru_cache(maxsize=16)）——
const clientCache = new Map<string, RetryingClient>()
const MAX_CACHE = 16

export function getClient(modelId: string, opts: LLMClientOptions): RetryingClient {
  let cached = clientCache.get(modelId)
  if (cached) return cached
  cached = new RetryingClient(opts)
  if (clientCache.size >= MAX_CACHE) {
    // 简单淘汰：删最早项
    const firstKey = clientCache.keys().next().value
    if (firstKey) clientCache.delete(firstKey)
  }
  clientCache.set(modelId, cached)
  return cached
}
