import { logger } from '../logger'
import { getKey } from '../secrets/vault'
import {
  buildSourceUrl,
  loadRegistryConfig,
  REGISTRY_TOKEN_KEY_ID,
  shouldAttachToken,
} from './sources'

// —— Registry HTTP 拉取（docs/REGISTRY_PLAN.md §4.1/§4.2）——
// 按配置源优先级逐个尝试，每源 8s 超时；全部失败抛错由调用方落缓存兜底。
// 浏览/下载走 raw/CDN 不耗 GitHub API 配额；token 仅附带给 GitHub 系域名。

const PER_SOURCE_TIMEOUT_MS = 8000
const UA = 'one-desktop-registry/0.1 (+https://github.com/shijianzhong/1)'

export interface RegistryFetchResult {
  data: string | Buffer
  /** 命中的源 id（排查用） */
  sourceId: string
}

async function fetchOne(
  url: string,
  sourceId: string,
  binary: boolean,
  token: string | null,
): Promise<RegistryFetchResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), PER_SOURCE_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { 'User-Agent': UA }
    if (token && shouldAttachToken(url)) {
      headers.Authorization = `Bearer ${token}`
    }
    const res = await fetch(url, { headers, signal: ctrl.signal })
    if (!res.ok) {
      throw new Error(`http_${res.status}`)
    }
    const data = binary ? Buffer.from(await res.arrayBuffer()) : await res.text()
    return { data, sourceId }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 按源优先级拉取 registry 文件。
 * @param path 仓库内相对路径（如 index.json / skills/web-research/skill.zip）
 * @throws Error 所有源均失败（message 含各源错误摘要）
 */
export async function registryFetch(
  path: string,
  opts?: { binary?: boolean },
): Promise<RegistryFetchResult> {
  const cfg = loadRegistryConfig()
  let token: string | null = null
  try {
    token = getKey(REGISTRY_TOKEN_KEY_ID)
  } catch (error) {
    // safeStorage 不可用不阻断无 token 访问
    logger.warn('[registry] 读取 token 失败，按无 token 继续', error)
  }

  const failures: string[] = []
  for (const source of cfg.sources) {
    const url = buildSourceUrl(source, cfg.repo, cfg.ref, path)
    try {
      return await fetchOne(url, source.id, opts?.binary ?? false, token)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      failures.push(`${source.id}: ${msg}`)
      logger.warn(`[registry] 源 ${source.id} 拉取 ${path} 失败：${msg}`)
    }
  }
  // 任一源 403 → 判为限流（§4.3）：渲染层据此展示「配置 Token 提升限额」引导条
  const code = failures.some((f) => f.includes('http_403'))
    ? 'registry_rate_limited'
    : 'registry_fetch_failed'
  throw new Error(`${code}: ${path}（${failures.join('；')}）`)
}
