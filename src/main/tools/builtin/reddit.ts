import { z } from 'zod'
import { registerTool } from '../registry'

// —— Reddit 帖子检索（内容生产 §2.2，范式A：HTTP fetch）——
// Reddit 公开 JSON：在搜索/子版 URL 后加 .json 即可，免 OAuth（带 UA，限流宽松）。
// 用于"某技术在 Reddit 上的讨论热度/开发者真实反馈"——选题红海度+实现空白判断。
// 错误策略仿 web.ts：4xx 结构化返回不重试，5xx 抛走 registry。
// 错误文案带 messageKey（铁律 T2）。

const TIMEOUT_MS = 30_000
const RESULT_CAP = 10
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

type FetchOutcome = { ok: true; data: unknown } | { ok: false; status: number }

async function fetchJson(url: string, signal: AbortSignal | undefined): Promise<FetchOutcome> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), TIMEOUT_MS)
  const onAbort = (): void => ctrl.abort(signal?.reason ?? new Error('aborted'))
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal })
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

interface RedditPost {
  title: string
  url: string
  permalink: string
  subreddit: string
  score: number
  numComments: number
  createdUtc: number
  selftext: string
}

/** 从 Reddit JSON children 节点抽出帖子 */
function extractPosts(data: unknown, limit: number): RedditPost[] {
  const root = data as {
    data?: { children?: Array<{ data?: Record<string, unknown> }> }
  }
  const children = root.data?.children ?? []
  const posts: RedditPost[] = []
  for (const c of children) {
    const d = c.data
    if (!d) continue
    const permalink = String(d.permalink ?? '')
    posts.push({
      title: String(d.title ?? ''),
      url: String(d.url ?? ''),
      permalink: permalink ? `https://www.reddit.com${permalink}` : '',
      subreddit: String(d.subreddit ?? ''),
      score: Number(d.score ?? 0),
      numComments: Number(d.num_comments ?? 0),
      createdUtc: Number(d.created_utc ?? 0),
      selftext: String(d.selftext ?? '').slice(0, 600),
    })
    if (posts.length >= limit) break
  }
  return posts
}

export function registerRedditTools(): void {
  registerTool(
    'reddit_search',
    'Reddit 帖子检索：搜某技术/项目在 Reddit 开发者社区的讨论热度与真实反馈。用于判断选题红海度+实现空白（有人讨论但没人做=红利）。免 OAuth，走公开 .json 端点。',
    z.object({
      query: z.string().describe('搜索词'),
      subreddit: z
        .string()
        .optional()
        .describe('限定子版，如 programming/MachineLearning/LocalLLaMA；不填则全站搜'),
      sort: z.enum(['relevance', 'hot', 'new', 'top']).optional().describe('排序，默认 relevance'),
      limit: z.number().int().min(1).max(25).optional().describe('返回条数，默认 10'),
    }),
    async (args, ctx) => {
      const { query, subreddit, sort, limit } = args as {
        query: string
        subreddit?: string
        sort?: 'relevance' | 'hot' | 'new' | 'top'
        limit?: number
      }
      const cap = limit ?? RESULT_CAP
      const s = sort ?? 'relevance'
      const url = subreddit
        ? `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/search.json?q=${encodeURIComponent(
            query,
          )}&sort=${s}&limit=${cap}&restrict_sr=1`
        : `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=${s}&limit=${cap}`
      const r = await fetchJson(url, ctx.signal)
      if (!r.ok) {
        return {
          ok: false,
          error: `http_${r.status}`,
          messageKey: r.status === 401 || r.status === 429
            ? 'errors.tools.search_rate_limited'
            : 'errors.tools.reddit_failed',
        }
      }
      const posts = extractPosts(r.data, cap)
      if (posts.length === 0) {
        return { ok: false, error: 'no_results', messageKey: 'errors.tools.search_no_results' }
      }
      return { ok: true, query, subreddit: subreddit ?? null, results: posts }
    },
  )
}
