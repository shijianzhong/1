import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { killProcessGroup } from '../processKill'
import path from 'node:path'
import { z } from 'zod'
import { registerTool } from '../registry'
import { logger } from '../../logger'

// —— OpenCLI 白名单工具（复用用户已登录浏览器会话操作网站）——
// 分发：生产环境走随包 vendor（extraResources → resources/opencli），
// 用 ELECTRON_RUN_AS_NODE 让应用主二进制当 Node 跑，用户零安装；
// 开发环境回退系统 PATH 的 opencli。
// 安全：白名单二进制 + (site,verb) 元组级 access 校验（只读放行、写一律拒绝）。

const TIMEOUT_MS = 120_000
const OUT_CAP = 16_000
/** stdout 累积上限（字符）：超过即 kill——超出部分对 LLM 无意义，且防异常命令 GB 级输出撑爆内存 */
const STDOUT_MAX_CHARS = 256 * 1024
/** stderr 只保留末尾（exitHint 只看尾部 500 字符，无需全量驻留内存） */
const STDERR_KEEP_CHARS = 8_000

// —— 安全：基于 cli-manifest.json 的 (site,verb)→access 白名单（铁律 §7.1b 自维护）——
// opencli 的每个子命令在 manifest 里显式标注 access: "read" | "write"。
// 关键洞察：同一动词名（download/answer/bookmark/...）在不同 site 下可能是 read 也可能是
// write（如 bilibili/download:read vs suno/download:write），故不能按动词名一刀切，
// 必须用 (site,verb) 元组查 manifest。manifest 随 vendor 更新而变 → 白名单自动同步，
// 新站点的 read 命令自动放行、write 命令仍拒绝，零维护。未知 (site,verb) 默认拒绝（fail-closed）。

interface CliManifestEntry {
  site: string
  name: string
  access: 'read' | 'write'
}

/** manifest 加载缓存：key = `${site}\0${verb}` → access；null 表示加载失败（降级旧黑名单） */
let accessMapCache: Map<string, 'read' | 'write'> | null = null
/** manifest 加载是否已尝试过（防重复读盘日志刷屏） */
let manifestLoadAttempted = false

/** 解析 cli-manifest.json 路径：随包 vendor 优先，开发回退 vendor/ 源目录 */
function resolveManifestPath(resourcesPath?: string): string | null {
  // 随包：resources/opencli/node_modules/@jackwener/opencli/cli-manifest.json
  if (resourcesPath) {
    const bundled = path.join(
      resourcesPath,
      'opencli',
      'node_modules',
      '@jackwener',
      'opencli',
      'cli-manifest.json',
    )
    if (existsSync(bundled)) return bundled
  }
  // 开发：vendor/opencli/node_modules/@jackwener/opencli/cli-manifest.json（相对 cwd）
  const devPath = path.join(
    process.cwd(),
    'vendor',
    'opencli',
    'node_modules',
    '@jackwener',
    'opencli',
    'cli-manifest.json',
  )
  if (existsSync(devPath)) return devPath
  return null
}

/**
 * 加载 (site,verb)→access 映射。懒加载 + 首次调用读盘 + 缓存。
 * 加载失败（manifest 缺失/损坏）返回 null → 调用方降级到 WRITE_VERBS_FALLBACK 黑名单
 * （保留旧防护，宁误杀不漏放）。
 */
function loadAccessMap(resourcesPath?: string): Map<string, 'read' | 'write'> | null {
  if (accessMapCache) return accessMapCache
  if (manifestLoadAttempted) return accessMapCache // 失败后不重试，避免每次调用读盘
  manifestLoadAttempted = true

  const manifestPath = resolveManifestPath(resourcesPath)
  if (!manifestPath) {
    logger.warn('[opencli] cli-manifest.json 未找到，安全校验降级为黑名单（建议 vendor:opencli 安装）')
    return null
  }
  try {
    const raw = readFileSync(manifestPath, 'utf8')
    const entries = JSON.parse(raw) as CliManifestEntry[]
    const map = new Map<string, 'read' | 'write'>()
    for (const e of entries) {
      if (typeof e.site === 'string' && typeof e.name === 'string' && (e.access === 'read' || e.access === 'write')) {
        map.set(`${e.site}\0${e.name}`, e.access)
      }
    }
    accessMapCache = map
    logger.info(`[opencli] manifest 加载成功：${map.size} 个 (site,verb) 条目`)
    return map
  } catch (error) {
    logger.warn('[opencli] manifest 解析失败，安全校验降级为黑名单', error)
    return null
  }
}

/**
 * 降级黑名单（manifest 不可用时用）：保留旧动词集合作为兜底防护。
 * 仅在 manifest 加载失败时生效，避免完全失防。
 */
const WRITE_VERBS_FALLBACK = new Set([
  'publish', 'follow', 'unfollow', 'like', 'favorite', 'comment', 'answer',
  'post', 'reply', 'reply-dm', 'delete', 'block', 'unblock', 'accept',
  'upvote', 'save', 'subscribe', 'connect', 'send', 'bookmark', 'unbookmark',
  'hide-reply', 'list-create', 'list-delete', 'list-add', 'list-add-batch',
  'list-remove', 'list-remove-batch', 'login', 'generate', 'describe', 'action',
  'task-create', 'task-claim', 'task-convert', 'task-delete', 'channel-create',
  'channel-join', 'message-send',
])

/**
 * 校验命令是否只读。args = [site, verb, ...]。
 * - manifest 可用：查 (site,verb)，read 放行；write 或未知 → 拒绝（fail-closed）。
 * - manifest 不可用：降级黑名单，verb 命中 WRITE_VERBS_FALLBACK → 拒绝。
 * 返回被拦截的写动词（供错误提示）或 null 表示放行。
 */
function findWriteViolation(cliArgs: string[], resourcesPath?: string): string | null {
  // args[0]=site, args[1]=verb；list/help/version 等全局只读命令（site 可能为 'list'）放行
  const site = cliArgs[0]
  const verb = cliArgs[1]
  if (!site) return null

  const map = loadAccessMap(resourcesPath)
  if (map) {
    // 全局只读命令：list（站点清单）、help、version、doctor（体检）——无 site/verb 配对，直接放行
    if (site === 'list' || (verb && ['help', 'version', 'doctor', '--help', '-h'].includes(verb))) {
      return null
    }
    if (!verb) return null // 仅传 site（如 `opencli zhihu`）通常等价 list，放行
    const access = map.get(`${site}\0${verb}`)
    if (access === 'write') return verb
    if (access === 'read') return null
    // 未知 (site,verb)：fail-closed，视为写拒绝
    return verb
  }

  // 降级：黑名单
  const writeVerb = cliArgs.find((a) => WRITE_VERBS_FALLBACK.has(a))
  return writeVerb ?? null
}

export interface OpenCliTarget {
  cmd: string
  argsPrefix: string[]
  env: NodeJS.ProcessEnv
}

/** 解析 opencli 入口：优先随包 vendor（生产），回退系统 PATH（开发/用户自装） */
export function resolveOpenCli(resourcesPath?: string): OpenCliTarget {
  if (resourcesPath) {
    const bundled = path.join(
      resourcesPath,
      'opencli',
      'node_modules',
      '@jackwener',
      'opencli',
      'dist',
      'src',
      'main.js',
    )
    if (existsSync(bundled)) {
      return {
        cmd: process.execPath,
        argsPrefix: [bundled],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      }
    }
  }
  return { cmd: 'opencli', argsPrefix: [], env: process.env }
}

interface CliOutcome {
  code: number | null
  stdout: string
  stderr: string
}

function runCli(
  target: OpenCliTarget,
  args: string[],
  signal: AbortSignal | undefined,
): Promise<CliOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(target.cmd, [...target.argsPrefix, ...args], {
      env: target.env,
      // detached:true → 子进程成为新进程组组长；终止时 process.kill(-pid) 连同
      // 孙进程（opencli 起的 Chrome、浏览器扩展进程）一并杀，防孤儿泄漏（P1-6）
      detached: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      killProcessGroup(child)
      reject(new Error('timeout'))
    }, TIMEOUT_MS)
    const onAbort = (): void => {
      killProcessGroup(child)
      reject(signal?.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
      if (stdout.length > STDOUT_MAX_CHARS) {
        clearTimeout(timer)
        killProcessGroup(child)
        reject(new Error(`stdout_limit_exceeded：输出超过 ${STDOUT_MAX_CHARS} 字符上限`))
      }
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-STDERR_KEEP_CHARS)
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

/** opencli 退出码（sysexits）→ 给 LLM 的可行动提示 */
function exitHint(code: number | null): string {
  switch (code) {
    case 66:
      return 'empty_result：查询无结果，换关键词或站点重试'
    case 69:
      return 'browser_bridge_down：Chrome 扩展（Browser Bridge）未连接——请用户在 Chrome 安装/启用 OpenCLI 扩展后重试'
    case 75:
      return 'timeout：浏览器命令超时，可重试一次'
    case 77:
      return 'auth_required：该站点浏览器登录态失效——请用户在 Chrome 里重新登录目标站点'
    case 78:
      return 'config_error：opencli 配置错误，可让用户终端跑 opencli doctor 排查'
    default:
      return '未知失败，可把 stderr 摘要告知用户，建议终端跑 opencli doctor 体检'
  }
}

export function registerOpenCliTools(): void {
  registerTool(
    'opencli_run',
    '通过用户本机已登录的浏览器会话读取网站内容（小红书/知乎/B站/Reddit/Twitter/微信公众号/HackerNews 等 100+ 站点，适合需要登录态的平台）。args 是 opencli 子命令参数数组，例如 ["xiaohongshu","search","关键词","--limit","5","-f","json"]、["zhihu","hot","-f","json"]、["bilibili","search","AI","-f","json"]。规则：只准用只读命令——按 (站点,动词) 在 cli-manifest 标 read 的放行，write 或未登记一律拒绝（发布/关注/点赞/登录等写操作禁止 agent 执行）；输出尽量带 "-f","json"；站点或命令不确定时先 ["list"] 查看支持的命令。',
    z.object({
      args: z
        .array(z.string())
        .min(1)
        .describe('opencli 子命令与参数（不含 "opencli" 本身）'),
    }),
    async (args, ctx) => {
      const { args: cliArgs } = args as { args: string[] }

      // (site,verb) 级 access 校验：manifest 标 read 放行，write/未知拒绝（fail-closed）。
      // manifest 缺失时降级 WRITE_VERBS_FALLBACK 黑名单（宁误杀不漏放）。
      const writeVerb = findWriteViolation(cliArgs, process.resourcesPath)
      if (writeVerb) {
        return {
          ok: false,
          error: 'write_op_blocked',
          hint: `"${writeVerb}" 是写操作或未登记的命令（发布/关注/点赞等），本应用禁止 agent 替用户写内容；如需请用户手动操作，或先用 ["list"] 确认命令是否只读`,
        }
      }

      const target = resolveOpenCli(process.resourcesPath)
      logger.info(`[opencli] run: ${cliArgs.join(' ')}（${target.argsPrefix.length ? 'bundled' : 'system'}）`)

      let outcome: CliOutcome
      try {
        outcome = await runCli(target, cliArgs, ctx.signal)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes('ENOENT')) {
          return {
            ok: false,
            error: 'opencli_not_found',
            hint: '未检测到 opencli。请用户安装（npm i -g @jackwener/opencli）并装 Chrome 扩展，或使用打包版应用（随包内置）',
          }
        }
        if (msg.startsWith('stdout_limit_exceeded')) {
          // 结构化返回（不 throw 走 registry 重试——超限重试只会再超限，白费 3 次）
          return {
            ok: false,
            error: 'stdout_limit_exceeded',
            hint: `输出超过 ${Math.round(STDOUT_MAX_CHARS / 1024)}KB 上限已终止。缩小查询范围（更精确关键词、更小 --limit）后重试`,
          }
        }
        throw e // 交给 registry 重试/错误 JSON（铁律11）
      }

      const stdout = outcome.stdout.slice(0, OUT_CAP)
      if (outcome.code === 0) {
        return {
          ok: true,
          output: stdout,
          truncated: outcome.stdout.length > OUT_CAP,
        }
      }
      return {
        ok: false,
        error: `exit_${outcome.code ?? 'unknown'}`,
        hint: exitHint(outcome.code),
        stderr: outcome.stderr.slice(-500),
      }
    },
  )
}
