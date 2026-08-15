import { z } from 'zod'
import { registerTool } from '../registry'

// —— Exa 语义搜索（内容生产 §2.2，范式A：HTTP fetch）——
// Exa 做语义检索，适合找"这个方向最近有什么讨论/爆款选题"。
// key 从 process.env.EXA_API_KEY；无 key → 结构化错误，不抛异常（铁律11）。
// 错误策略仿 web.ts：4xx 不重试返回 JSON，5xx/网络抛走 registry 重试层。
// 错误文案带 messageKey（铁律 T2），不硬编码中文给渲染层翻译。

const TIMEOUT_MS = 30_000
const RESULT_CAP = 8
const TEXT_CAP = 4_000

type FetchOutcome =
  | { ok: true; data: unknown }
  | { ok: false; status: number }

async function postJson(
  url: string,
  body: unknown,
  signal: AbortSignal | undefined,
  headers: Record<string, string>,
): Promise<FetchOutcome> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), TIMEOUT_MS)
  const onAbort = (): void => ctrl.abort(signal?.reason ?? new Error('aborted'))
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok && res.status < 500) return { ok: false, status: res.status }
    if (!res.ok) return { ok: false, status: res.status }
    try {
      return { ok: true, data: await res.json() }
    } catch {
      return { ok: false, status: 502 }
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

interface ExaResult {
  title: string
  url: string
  snippet: string
  publishedDate?: string
}

export function registerExaTools(): void {
  registerTool(
    'exa_search',
    'Exa 语义搜索：按语义而非关键词匹配找全网相关内容，适合"这个方向最近有什么讨论/爆款选题"。需要环境变量 EXA_API_KEY。拿到结果后对重点页用 web_read 读全文。',
    z.object({
      query: z.string().describe('语义查询：描述你要找的内容主题，而非关键词'),
      numResults: z.number().int().min(1).max(10).optional().describe('返回条数，默认 8'),
      startPublishedDate: z
        .string()
        .optional()
        .describe('ISO 日期，如 2026-08-01，只返回此日期之后发布的内容（提时效）'),
    }),
    async (args, ctx) => {
      const { query, numResults, startPublishedDate } = args as {
        query: string
        numResults?: number
        startPublishedDate?: string
      }
      const key = process.env.EXA_API_KEY
      if (!key) {
        return { ok: false, error: 'no_key', messageKey: 'errors.tools.exa_no_key' }
      }
      const r = await postJson(
        'https://api.exa.ai/search',
        {
          query,
          numResults: numResults ?? RESULT_CAP,
          useAutoprompt: true,
          startPublishedDate,
          contents: { text: { maxCharacters: TEXT_CAP } },
        },
        ctx.signal,
        { 'x-api-key': key },
      )
      if (!r.ok) {
        return {
          ok: false,
          error: `http_${r.status}`,
          messageKey: r.status === 401 || r.status === 429
            ? 'errors.tools.search_rate_limited'
            : 'errors.tools.exa_failed',
        }
      }
      const data = r.data as {
        results?: Array<{
          title?: string
          url?: string
          publishedDate?: string
          text?: string
          score?: number
        }>
      }
      const results: ExaResult[] = (data.results ?? []).slice(0, numResults ?? RESULT_CAP).map((item) => ({
        title: item.title ?? '',
        url: item.url ?? '',
        snippet: (item.text ?? '').slice(0, 500),
        publishedDate: item.publishedDate,
      })).filter((r) => r.url)
      if (results.length === 0) {
        return {
          ok: false,
          error: 'no_results',
          messageKey: 'errors.tools.search_no_results',
        }
      }
      return { ok: true, query, results }
    },
  )
}
