import { readFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { IpcErrorThrow, type RegistryExportConfirmItem } from '@shared/types'
import { logger } from '../logger'
import { getKey } from '../secrets/vault'
import { loadRegistryConfig, REGISTRY_TOKEN_KEY_ID } from './sources'

// —— GitHub API 自动 PR（docs/REGISTRY_PLAN.md §3.3 方式 B + §4.3 权限表，Phase 5）——
// fork（幂等）→ 在 fork 建 publish 分支 → Contents API 逐文件提交（base64）→ 对上游开 PR。
// Token 要求：classic 勾 repo / fine-grained 对 fork 授 Contents+PR 读写——缺权限 403/404
// 时抛出带引导的错误码，渲染层给分场景提示（设置页文案已对齐）。

const API = 'https://api.github.com'
const UA = 'one-desktop-registry/0.1 (+https://github.com/shijianzhong/1)'
const PER_REQUEST_TIMEOUT_MS = 15000

export interface PublishPrResult {
  prUrl: string
  prNumber: number
  /** true = 复用了已存在的 open PR（422 回退） */
  reused?: boolean
}

class GhError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

async function gh<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), PER_REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        'User-Agent': UA,
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (res.status === 204) return undefined as T
    const text = await res.text()
    const data = text ? (JSON.parse(text) as unknown) : undefined
    if (!res.ok) {
      const msg =
        typeof data === 'object' && data !== null && 'message' in data
          ? String((data as { message: unknown }).message)
          : `http_${res.status}`
      throw new GhError(res.status, msg)
    }
    return data as T
  } finally {
    clearTimeout(timer)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** fork 是异步建仓，轮询直到可读（最长 ~40s）。
 *  401/403/429 = 权限/限流，等也不会好，立即抛（经 toGhMessage 映射为分场景引导）；
 *  404 = 建仓窗口期属预期，继续等；网络/5xx 重试。 */
async function waitForkReady(token: string, forkFullName: string): Promise<void> {
  let lastError: unknown
  for (let i = 0; i < 20; i++) {
    try {
      await gh(token, 'GET', `/repos/${forkFullName}`)
      return
    } catch (error) {
      lastError = error
      if (error instanceof GhError && (error.status === 401 || error.status === 403 || error.status === 429)) {
        throw error
      }
      await sleep(2000)
    }
  }
  const last = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown')
  throw new IpcErrorThrow('errors.registry.pr_fork_timeout', `registry_pr_failed: fork ${forkFullName} 等待超时（最后错误：${last}）`)
}

function toGhError(error: unknown): IpcErrorThrow {
  if (error instanceof GhError) {
    if (error.status === 403) {
      return error.message.includes('rate limit')
        ? new IpcErrorThrow('errors.registry.pr_rate_limited', 'registry_rate_limited')
        : new IpcErrorThrow('errors.registry.pr_forbidden', 'registry_pr_forbidden')
    }
    if (error.status === 401) return new IpcErrorThrow('errors.registry.pr_unauthorized', 'registry_pr_unauthorized')
    if (error.status === 404) return new IpcErrorThrow('errors.registry.pr_not_found', 'registry_pr_not_found')
    return new IpcErrorThrow('errors.registry.pr_failed', `registry_pr_failed: ${error.message}`)
  }
  return new IpcErrorThrow('errors.registry.pr_failed', `registry_pr_failed: ${error instanceof Error ? error.message : String(error)}`)
}

/**
 * 把导出目录内容经 GitHub API 提交为上游 PR。
 * @param dir 导出根目录（one-registry-export/）
 * @param files 相对路径清单（applyExport 返回值）
 * @param items 导出确认项（生成 PR 标题/正文）
 */
export async function submitExportAsPr(
  dir: string,
  files: string[],
  items: RegistryExportConfirmItem[],
): Promise<PublishPrResult> {
  const token = getKey(REGISTRY_TOKEN_KEY_ID)
  if (!token) {
    throw new IpcErrorThrow('errors.registry.pr_no_token')
  }
  const upstream = loadRegistryConfig().repo
  const upstreamRef = loadRegistryConfig().ref

  try {
    const user = await gh<{ login: string }>(token, 'GET', '/user')
    // fork 幂等：已存在直接返回
    const fork = await gh<{ full_name: string; default_branch: string }>(
      token,
      'POST',
      `/repos/${upstream}/forks`,
    )
    await waitForkReady(token, fork.full_name)

    const baseRef = await gh<{ object: { sha: string } }>(
      token,
      'GET',
      `/repos/${fork.full_name}/git/refs/heads/${fork.default_branch}`,
    )
    const primary = items[0]
    // 秒级精度：同分钟重复发布同 slug 不再撞分支名（refs POST 422）
    const stamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, '')
      .slice(0, 14)
    const branch = `publish/${primary.slug}-${stamp}`
    await gh(token, 'POST', `/repos/${fork.full_name}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: baseRef.object.sha,
    })

    // Contents API 逐文件提交（已存在文件需带 sha 覆盖）
    for (const rel of files) {
      const apiPath = rel.split(sep).join('/')
      let existingSha: string | undefined
      try {
        const existing = await gh<{ sha: string }>(
          token,
          'GET',
          `/repos/${fork.full_name}/contents/${apiPath}?ref=${encodeURIComponent(branch)}`,
        )
        existingSha = existing.sha
      } catch {
        // 404 = 新文件
      }
      const content = await readFile(join(dir, rel))
      await gh(token, 'PUT', `/repos/${fork.full_name}/contents/${apiPath}`, {
        message: `${existingSha ? 'update' : 'add'}: ${apiPath}`,
        content: content.toString('base64'),
        branch,
        ...(existingSha ? { sha: existingSha } : {}),
      })
    }

    const title = `publish: ${primary.slug} v${primary.version}${items.length > 1 ? ` (+${items.length - 1} deps)` : ''}`
    const body = [
      'Submitted from One desktop app (registry export).',
      '',
      '## Assets',
      ...items.map((i) => `- **${i.kind}** \`${i.slug}\` v${i.version}`),
      '',
      '## Files',
      ...files.map((f) => `- \`${f.split(sep).join('/')}\``),
    ].join('\n')

    try {
      const pr = await gh<{ html_url: string; number: number }>(
        token,
        'POST',
        `/repos/${upstream}/pulls`,
        {
          title,
          head: `${user.login}:${branch}`,
          base: upstreamRef,
          body,
          maintainer_can_modify: true,
        },
      )
      logger.info(`[registry] 自动 PR 创建成功：${pr.html_url}`)
      return { prUrl: pr.html_url, prNumber: pr.number }
    } catch (error) {
      // 422 = 同分支已有 open PR（重试场景），捞出直接返回
      if (error instanceof GhError && error.status === 422) {
        const existing = await gh<Array<{ html_url: string; number: number }>>(
          token,
          'GET',
          `/repos/${upstream}/pulls?head=${encodeURIComponent(`${user.login}:${branch}`)}&state=open`,
        )
        if (existing.length > 0) {
          return { prUrl: existing[0].html_url, prNumber: existing[0].number, reused: true }
        }
      }
      throw error
    }
  } catch (error) {
    logger.warn('[registry] 自动 PR 失败', error)
    throw toGhError(error)
  }
}

/** 仓库统计（star/fork 数，列表页展示；无 token 走匿名 60/h 配额） */
export async function getRepoStats(): Promise<{ stars: number; forks: number }> {
  const repo = loadRegistryConfig().repo
  let token: string | null = null
  try {
    token = getKey(REGISTRY_TOKEN_KEY_ID)
  } catch {
    // 无 token 走匿名
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), PER_REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${API}/repos/${repo}`, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/vnd.github+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`http_${res.status}`)
    const data = (await res.json()) as { stargazers_count?: number; forks_count?: number }
    return { stars: data.stargazers_count ?? 0, forks: data.forks_count ?? 0 }
  } finally {
    clearTimeout(timer)
  }
}
