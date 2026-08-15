import { spawn } from 'node:child_process'
import { z } from 'zod'
import { registerTool } from '../registry'
import { logger } from '../../logger'

// —— GitHub trending/仓库核验（内容生产 §2.2，范式B：spawn gh CLI）——
// 用途：选题调研锁真火项目（gh search repos / trending）、Review 阶段核验 star/issue
//   是否属实（防 AI 编造，铁律 review §1）。命令白名单只放读取类。
// 依赖：gh CLI 在 PATH（用户 GitHub 登录态，gh auth status）。无 gh → 结构化错误。
// 错误策略：ENOENT/超限不重试返回 JSON；非零退出返回 exit code+hint；网络抛走 registry。
// 错误文案带 messageKey（铁律 T2）。

const TIMEOUT_MS = 60_000
const OUT_CAP = 16_000
const STDOUT_MAX_CHARS = 256 * 1024

/** 命令白名单前缀：只准 gh 读取类子命令，禁止 repo delete/auth logout 等写操作 */
const ALLOWED_PREFIXES = new Set([
  'search repos',
  'search code',
  'search issues',
  'repo view',
  'repo view --json',
  'api repos',
  'api search',
])

interface GhOutcome {
  code: number | null
  stdout: string
  stderr: string
}

function runGh(args: string[], signal: AbortSignal | undefined): Promise<GhOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, {
      env: process.env,
      detached: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('timeout'))
    }, TIMEOUT_MS)
    const onAbort = (): void => {
      child.kill('SIGKILL')
      reject(signal?.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
      if (stdout.length > STDOUT_MAX_CHARS) {
        clearTimeout(timer)
        child.kill('SIGKILL')
        reject(new Error(`stdout_limit_exceeded：输出超过 ${STDOUT_MAX_CHARS} 字符上限`))
      }
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-8_000)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ code, stdout, stderr })
    })
  })
}

/** 校验 gh 子命令在白名单内 */
function isAllowed(args: string[]): boolean {
  const joined = args.join(' ')
  return [...ALLOWED_PREFIXES].some((p) => joined.startsWith(p))
}

export function registerGhTools(): void {
  registerTool(
    'gh_search',
    'GitHub 仓库/代码/issue 检索与核验：用 gh CLI 搜 trending 项目、按关键词找仓库、查看某仓库 star/issue 等元数据。选题阶段锁真火项目（避免写过气项目），Review 阶段核验引用的 star 数是否属实（防 AI 编造）。需用户本机已安装并登录 gh（gh auth status）。',
    z.object({
      action: z
        .enum(['search_repos', 'repo_view', 'search_code', 'search_issues'])
        .describe('search_repos=按关键词搜仓库；repo_view=查某仓库元数据；search_code=搜代码；search_issues=搜 issue'),
      query: z.string().describe('搜索词或 owner/repo（repo_view 用）'),
      limit: z.number().int().min(1).max(30).optional().describe('返回条数，默认 10'),
    }),
    async (args, ctx) => {
      const { action, query, limit } = args as {
        action: 'search_repos' | 'repo_view' | 'search_code' | 'search_issues'
        query: string
        limit?: number
      }
      const cap = limit ?? 10
      let ghArgs: string[]
      switch (action) {
        case 'search_repos':
          ghArgs = ['search', 'repos', query, `--limit=${cap}`, '--json=nameWithOwner,description,stargazerCount,language,url,updatedAt']
          break
        case 'repo_view':
          ghArgs = ['repo', 'view', query, '--json=nameWithOwner,description,stargazerCount,forkCount,issues,url,updatedAt']
          break
        case 'search_code':
          ghArgs = ['search', 'code', query, `--limit=${cap}`, '--json=path,repository,textMatches']
          break
        case 'search_issues':
          ghArgs = ['search', 'issues', query, `--limit=${cap}`, '--json,title,url,state,createdAt']
          break
      }
      if (!isAllowed(ghArgs)) {
        return { ok: false, error: 'command_not_allowed', hint: '仅允许 gh 读取类子命令' }
      }
      logger.info(`[gh] run: gh ${ghArgs.join(' ')}`)
      let outcome: GhOutcome
      try {
        outcome = await runGh(ghArgs, ctx.signal)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes('ENOENT')) {
          return {
            ok: false,
            error: 'gh_not_found',
            messageKey: 'errors.tools.gh_not_found',
            hint: '未检测到 gh CLI，请用户安装（brew install gh）并 gh auth login',
          }
        }
        if (msg.startsWith('stdout_limit_exceeded')) {
          return {
            ok: false,
            error: 'stdout_limit_exceeded',
            hint: `输出超限，缩小 --limit 或换更精确关键词`,
          }
        }
        throw e // 网络错误交 registry 重试（铁律11）
      }
      const stdout = outcome.stdout.slice(0, OUT_CAP)
      if (outcome.code === 0) {
        // gh --json 返回 JSON 数组/对象，原样回传让 agent 解析
        let parsed: unknown = stdout
        try {
          parsed = JSON.parse(stdout)
        } catch {
          // 非 JSON（如纯文本 view），保留原文
        }
        return {
          ok: true,
          action,
          query,
          result: parsed,
          truncated: outcome.stdout.length > OUT_CAP,
        }
      }
      return {
        ok: false,
        error: `exit_${outcome.code ?? 'unknown'}`,
        messageKey: 'errors.tools.gh_failed',
        hint: 'gh 非零退出，可能未登录（gh auth login）或仓库不存在',
        stderr: outcome.stderr.slice(-500),
      }
    },
  )
}
