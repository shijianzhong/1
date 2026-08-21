import { z } from 'zod'
import { registerTool } from '../registry'
import { logger } from '../../logger'
import { fetchWithTimeout } from '../../util/net'
import { stripTags, decodeEntities } from '../../util/html'

// —— 内置联网工具（P2-search：搜索后端优先 API，弃用裸爬 Bing HTML）——
// web_read   = Jina Reader（r.jina.ai，免 key 有限流；JINA_API_KEY 提额）
// web_search = 后端优先级：Brave API > Jina Search > Bing HTML（降级 fallback）
//              Brave：BRAVE_API_KEY 环境变量，REST API，结构化 JSON
//              Jina：JINA_API_KEY 环境变量，语义搜索
//              Bing：免 key 降级（反爬风险，仅最后手段）
//
// 错误策略：4xx（鉴权/限流）重试无意义 → 直接返回结构化错误 JSON；
// 5xx/网络错误 → 抛出，交给 registry 重试层（铁律11）。
// 错误文案用 messageKey（铁律 T2），不硬编码中文。

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
  // 超时 + signal 链接走共享 helper（util/net.ts，与 KB URL 摄取同源）
  const res = await fetchWithTimeout(url, {
    timeoutMs: TIMEOUT_MS,
    signal,
    headers: { 'User-Agent': UA, ...extraHeaders },
  })
  if (!res.ok && res.status < 500) return { ok: false, status: res.status }
  if (!res.ok) throw new Error(`http_${res.status}`)
  return { ok: true, text: await res.text() }
}

/** fetch JSON（Brave API 等结构化接口用） */
async function fetchJson(
  url: string,
  signal: AbortSignal | undefined,
  extraHeaders: Record<string, string> = {},
): Promise<{ ok: true; data: unknown } | { ok: false; status: number }> {
  const r = await fetchText(url, signal, extraHeaders)
  if (!r.ok) return r
  try {
    return { ok: true, data: JSON.parse(r.text) }
  } catch {
    return { ok: false, status: 502 }
  }
}

// —— 搜索结果结构 ——
interface SearchResult {
  title: string
  url: string
  snippet: string
}

// —— Bing CN HTML 结果解析（降级 fallback，保留原实现）——
// stripTags/decodeEntities 用共享实现（util/html.ts，与 KB 抽取同源）
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

/** Brave Search API：结构化 JSON，无反爬 */
async function searchBrave(
  query: string,
  signal: AbortSignal | undefined,
): Promise<{ ok: true; results: SearchResult[] } | { ok: false; error: string; messageKey: string }> {
  const key = process.env.BRAVE_API_KEY
  if (!key) return { ok: false, error: 'no_key', messageKey: 'errors.tools.search_no_key' }

  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${SEARCH_LIMIT}`
  // 整段包 try/catch（断言 4.4）：fetchText 对 5xx 直接 throw（web.ts:40），5xx 冒泡到
  // 这里若不接住 → registry 重试 3 次全 5xx → 降级链（Jina/Bing）永远到不了。
  // 现接住返回 {ok:false} 让降级链继续；4xx 已由 fetchJson 转 {ok:false} 不走 throw。
  try {
    const r = await fetchJson(url, signal, {
      'X-Subscription-Token': key,
      Accept: 'application/json',
    })
    if (!r.ok) {
      return {
        ok: false,
        error: `http_${r.status}`,
        messageKey: r.status === 401 || r.status === 429
          ? 'errors.tools.search_rate_limited'
          : 'errors.tools.search_failed',
      }
    }

    const data = r.data as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } }
    const raw = data.web?.results ?? []
    const results: SearchResult[] = raw.slice(0, SEARCH_LIMIT).map((item) => ({
      title: item.title ?? '',
      url: item.url ?? '',
      snippet: item.description ?? '',
    })).filter((r) => r.url)

    return { ok: true, results }
  } catch (e) {
    // 5xx / 网络错误：不 throw，降级到 Jina/Bing（断言 4.4 修复）
    const msg = e instanceof Error ? e.message : String(e)
    logger.warn(`[web] Brave 5xx/网络错误，降级到 Jina：${msg}`)
    return { ok: false, error: `brave_${msg}`, messageKey: 'errors.tools.search_failed' }
  }
}

/** Jina Search：语义搜索，需 JINA_API_KEY */
async function searchJina(
  query: string,
  signal: AbortSignal | undefined,
): Promise<{ ok: true; text: string } | { ok: false; error: string; messageKey: string }> {
  const key = process.env.JINA_API_KEY
  if (!key) return { ok: false, error: 'no_key', messageKey: 'errors.tools.search_no_key' }

  const r = await fetchText(
    `https://s.jina.ai/?q=${encodeURIComponent(query)}`,
    signal,
    { Authorization: `Bearer ${key}` },
  )
  if (!r.ok) {
    return {
      ok: false,
      error: `http_${r.status}`,
      messageKey: 'errors.tools.search_failed',
    }
  }
  return { ok: true, text: r.text }
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
        return { ok: false, error: 'invalid_url', hint: 'url must start with http(s)://' }
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
              ? 'Jina Reader rate-limited: set JINA_API_KEY env var, or retry later'
              : 'Failed to read page, try web_search for other sources',
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

      // —— 1. Brave Search API（首选：结构化 JSON，无反爬）——
      const brave = await searchBrave(query, ctx.signal)
      if (brave.ok) {
        return { ok: true, query, backend: 'brave', results: brave.results }
      }
      // 无 key → 静默跳过降级；有 key 但失败（5xx/网络/限流）→ 记一行日志降级到 Jina
      if (brave.error !== 'no_key') {
        logger.info(`[web] Brave 失败（${brave.error}），降级到 Jina`)
      }

      // —— 2. Jina Search（次选：语义搜索，需 key）——
      const jina = await searchJina(query, ctx.signal)
      if (jina.ok) {
        return {
          ok: true,
          query,
          backend: 'jina',
          results: jina.text.slice(0, SEARCH_CAP),
          truncated: jina.text.length > SEARCH_CAP,
        }
      }

      // —— 3. Bing CN HTML（降级 fallback：免 key，但有反爬风险）——
      const r = await fetchText(
        `https://cn.bing.com/search?q=${encodeURIComponent(query)}`,
        ctx.signal,
      )
      if (!r.ok) {
        return {
          ok: false,
          error: `http_${r.status}`,
          messageKey: 'errors.tools.search_failed',
          hint: 'Search backend unavailable: set BRAVE_API_KEY or JINA_API_KEY for better results',
        }
      }
      const results = parseBingHtml(r.text, SEARCH_LIMIT)
      if (results.length === 0) {
        return {
          ok: false,
          error: 'no_results',
          messageKey: 'errors.tools.search_no_results',
          hint: 'No results parsed (possible anti-bot): try different keywords or set BRAVE_API_KEY',
        }
      }
      return { ok: true, query, backend: 'bing', results }
    },
  )
}
