import { createHash } from 'node:crypto'
import { APIError, AuthenticationError, BadRequestError } from '@anthropic-ai/sdk'
import type { LlmRequest, LlmResponse } from '@shared/types'
import { logger } from '../logger'
import { LLMClient, type LLMClientOptions, type LLMProtocol } from './client'
import { OpenAILLMClient } from './openai-client'

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

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const s = (error as { status?: unknown }).status
  return typeof s === 'number' ? s : undefined
}

function isRetryable(error: unknown): boolean {
  // 401/400/ValidationError 不重试（§三之三 H）
  if (error instanceof AuthenticationError) return false
  if (error instanceof BadRequestError) return false

  // Anthropic APIError：看 status
  if (error instanceof APIError) {
    const status = error.status ?? 0
    return status === 429 || (status >= 500 && status <= 504)
  }

  // OpenAI 适配器等：普通 Error 挂 .status（非 APIError 实例）
  const duckStatus = statusOf(error)
  if (duckStatus !== undefined) {
    if (duckStatus === 401 || duckStatus === 400) return false
    return duckStatus === 429 || (duckStatus >= 500 && duckStatus <= 504)
  }

  // —— duck-typing 兜底（SDK 在 ESM/打包下 instanceof 可能失效，§三之三 H）——
  // 任何含 429/rate_limit/overloaded/5xx/backend returned 的都重试
  const errStr = (
    error instanceof Error
      ? `${error.name} ${error.message}`
      : typeof error === 'string'
        ? error
        : JSON.stringify(error)
  ).toLowerCase()

  // 401/400 明确不重试（即使 instanceof 失效）
  if (/401|400|bad.?request|unauthor/i.test(errStr)) return false

  // —— 模型吐畸形 tool input JSON（铁律11 精神延伸）——
  // Anthropic SDK 流式累积 tool input 时解析失败抛裸 AnthropicError（无 status，非 APIError
  // 子类），消息模板固定 "Unable to parse tool parameter JSON from model..."。模型偶发吐畸形
  // JSON 是正常现象（尤其复杂 graph 嵌套），SDK 官方建议 retry。上面所有分支都 miss 它，
  // 不在此拦截 → 直接抛 → 崩整个 chat。用原始 message 前缀匹配（errStr 已 toLowerCase，
  // 但 SDK 模板是混合大小写，用原始 message 更稳）。
  if (error instanceof Error && error.message.startsWith('Unable to parse tool parameter JSON')) {
    return true
  }

  if (error instanceof Error) {
    const name = error.name.toLowerCase()
    // name 或 message 任一含网络/超时/中转关键词即重试
    if (/network|fetch|abort|timeout|connection|econn|enotfound/i.test(name)) return true
  }
  if (/network|fetch|abort|timeout|connection|econn|enotfound/i.test(errStr)) return true
  // 消息里带 5xx 状态码（如 "OpenAI API 503: ..."）也重试
  if (/\b(429|500|502|503|504)\b/.test(errStr)) return true
  return GATEWAY_RETRY_KEYWORDS.some((kw) => errStr.includes(kw))
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
    const onAbort = (): void => {
      clearTimeout(t)
      reject(signal!.reason ?? new Error('aborted'))
    }
    const t = setTimeout(() => {
      // 正常到时也要摘掉 abort 监听——否则长寿命 signal（整场运行共享）上
      // 每次重试 sleep 都累积一个闭包监听器，且回调闭包持有 t 阻止 GC
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class RetryingClient {
  private readonly inner: LLMProtocol

  constructor(clientOrOpts: LLMProtocol | LLMClientOptions = {}) {
    // duck-type：有 stream 方法即视为已构造的 client（便于测试注入 mock）
    if (clientOrOpts && typeof (clientOrOpts as LLMProtocol).stream === 'function') {
      this.inner = clientOrOpts as LLMProtocol
    } else {
      const opts = clientOrOpts as LLMClientOptions
      // P1#4：按 apiFormat 路由到对应协议适配器
      // custom = 仍走 Anthropic SDK（兼容网关）；非 Anthropic 端点请显式选 openai
      if (opts.apiFormat === 'custom') {
        logger.warn(
          '[llm] apiFormat=custom 按 Anthropic 协议发送；若端点是 OpenAI 兼容请改选 openai',
        )
      }
      this.inner = opts.apiFormat === 'openai'
        ? new OpenAILLMClient(opts)
        : new LLMClient(opts)
    }
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

// —— client 按 modelId+baseURL+authHeader+apiKey 缓存（§三之三 H：@lru_cache(maxsize=16)）——
// 缓存键必须区分不同供应商/凭据，否则同一 modelId 不同 baseURL 会命中错误的 client。
const clientCache = new Map<string, RetryingClient>()
const MAX_CACHE = 16

/** 生成缓存键：modelId + baseURL + authHeader + apiFormat + apiKey 哈希 */
function makeCacheKey(modelId: string, opts: LLMClientOptions): string {
  const keyHash = opts.apiKey ? hashApiKey(opts.apiKey) : 'none'
  return `${modelId}|${opts.baseURL ?? ''}|${opts.authHeader ?? ''}|${opts.apiFormat ?? ''}|${keyHash}`
}

/** 哈希 apiKey（sha256 截 96bit），避免明文存入 Map key */
function hashApiKey(key: string): string {
  return `h${createHash('sha256').update(key).digest('base64url').slice(0, 16)}`
}

export function getClient(modelId: string, opts: LLMClientOptions): RetryingClient {
  const cacheKey = makeCacheKey(modelId, opts)
  let cached = clientCache.get(cacheKey)
  if (cached) return cached
  cached = new RetryingClient(opts)
  if (clientCache.size >= MAX_CACHE) {
    // 简单淘汰：删最早项
    const firstKey = clientCache.keys().next().value
    if (firstKey) clientCache.delete(firstKey)
  }
  clientCache.set(cacheKey, cached)
  return cached
}
