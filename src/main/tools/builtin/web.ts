import { z } from 'zod'
import { registerTool } from '../registry'

// —— 内置联网工具（零依赖：纯 HTTP，随包即用，对应 Agent-Reach 免费渠道的 TS 原生实现）——
// web_read   = Jina Reader（r.jina.ai，免 key 有限流；JINA_API_KEY 提额）
// web_search = 默认 Bing CN HTML（免 key、国内直连；摘要自带相对日期利于时效筛选）；
//              设 JINA_API_KEY 后走 Jina Search（语义质量更高）
//              （DuckDuckGo 国内不可达、s.jina.ai 免 key 已 401，均弃用）
//
// 错误策略：4xx（鉴权/限流）重试无意义 → 直接返回结构化错误 JSON；
// 5xx/网络错误 → 抛出，交给 registry 重试层（铁律11）。

const READ_CAP = 12_000
const SEARCH_CAP = 6_000
const SEARCH_LIMIT = 8
const TIMEOUT_MS = 30_000

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

type FetchOutcome = { ok: true; text: string } | { ok: false; status: number }

async function fetchText(
  url: string,
  signal: AbortSignal | undefined,
  extraHeaders: Record<string, string> = {},
): Promise<FetchOutcome> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), TIMEOUT_MS)
  const onAbort = (): void => ctrl.abort(signal?.reason ?? new Error('aborted'))
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, ...extraHeaders },
      signal: ctrl.signal,
    })
    if (!res.ok && res.status < 500) return { ok: false, status: res.status }
    if (!res.ok) throw new Error(`http_${res.status}`)
    return { ok: true, text: await res.text() }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

// —— Bing CN HTML 结果解析（b_algo 块 → h2 内锚点直连 URL + b_lineclampN 摘要）——

interface SearchResult {
  title: string
  url: string
  snippet: string
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '')
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", '#x2F': '/',
    nbsp: ' ', ensp: ' ', emsp: ' ', middot: '·', hellip: '…', mdash: '—', ndash: '–',
  }
  return s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, entity: string) => {
    if (named[entity]) return named[entity]
    if (entity.startsWith('#x')) return String.fromCodePoint(parseInt(entity.slice(2), 16))
    if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10))
    return m
  })
}

function parseBingHtml(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = []
  for (const block of html.split('b_algo').slice(1)) {
    const h2 = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)
    const a = h2?.[1].match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!a) continue
    const url = a[1]
    if (!url.startsWith('http')) continue
    const p = block.match(/<p[^>]*class="b_lineclamp\d"[^>]*>([\s\S]*?)<\/p>/)
    results.push({
      title: decodeEntities(stripTags(a[2])).trim(),
      url,
      snippet: p ? decodeEntities(stripTags(p[1])).trim() : '',
    })
    if (results.length >= limit) break
  }
  return results
}

export function registerWebTools(): void {
  registerTool(
    'web_read',
    '读取任意网页正文（自动转 Markdown，剥掉导航/广告噪音）。用于打开搜索结果、读文章/帖子/公告全文。',
    z.object({
      url: z.string().describe('完整 URL，含 https://'),
    }),
    async (args, ctx) => {
      const { url } = args as { url: string }
      if (!/^https?:\/\//.test(url)) {
        return { ok: false, error: 'invalid_url', hint: 'url 必须以 http(s):// 开头' }
      }
      const key = process.env.JINA_API_KEY
      const r = await fetchText(
        `https://r.jina.ai/${url}`,
        ctx.signal,
        key ? { Authorization: `Bearer ${key}` } : {},
      )
      if (!r.ok) {
        return {
          ok: false,
          error: `http_${r.status}`,
          hint:
            r.status === 401 || r.status === 429
              ? 'Jina Reader 免 key 额度受限：设置 JINA_API_KEY 环境变量提额，或稍后重试'
              : '目标页读取失败，可换 web_search 找其它来源',
        }
      }
      return {
        ok: true,
        url,
        content: r.text.slice(0, READ_CAP),
        truncated: r.text.length > READ_CAP,
      }
    },
  )

  registerTool(
    'web_search',
    '全网实时搜索，返回相关网页的标题/链接/摘要。用于调研最新资讯、查证事实、找资料来源。拿到结果后对重点页面用 web_read 读全文。注意按用户要求的时间范围筛选结果，过期内容不要采用。',
    z.object({
      query: z.string().describe('搜索词：具体、明确，可带时间词（如"最近""2026"）提高时效性'),
    }),
    async (args, ctx) => {
      const { query } = args as { query: string }

      // 带 key → Jina Search（语义质量更高）；否则 Bing CN（免 key、国内直连）
      const key = process.env.JINA_API_KEY
      if (key) {
        const r = await fetchText(
          `https://s.jina.ai/?q=${encodeURIComponent(query)}`,
          ctx.signal,
          { Authorization: `Bearer ${key}` },
        )
        if (r.ok) {
          return {
            ok: true,
            query,
            backend: 'jina',
            results: r.text.slice(0, SEARCH_CAP),
            truncated: r.text.length > SEARCH_CAP,
          }
        } // key 失效等 → 落 Bing
      }

      const r = await fetchText(
        `https://cn.bing.com/search?q=${encodeURIComponent(query)}`,
        ctx.signal,
      )
      if (!r.ok) {
        return {
          ok: false,
          error: `http_${r.status}`,
          hint: 'Bing 搜索被拒（可能限流）：稍后重试，或设置 JINA_API_KEY 走 Jina 搜索后端',
        }
      }
      const results = parseBingHtml(r.text, SEARCH_LIMIT)
      if (results.length === 0) {
        return {
          ok: false,
          error: 'no_results',
          hint: '未解析到结果（可能触发风控或确实无结果）：换关键词重试，或设置 JINA_API_KEY 走 Jina 后端',
        }
      }
      return { ok: true, query, backend: 'bing', results }
    },
  )
}
