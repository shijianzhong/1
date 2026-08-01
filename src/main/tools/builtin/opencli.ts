import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { registerTool } from '../registry'
import { logger } from '../../logger'

// —— OpenCLI 白名单工具（复用用户已登录浏览器会话操作网站）——
// 分发：生产环境走随包 vendor（extraResources → resources/opencli），
// 用 ELECTRON_RUN_AS_NODE 让应用主二进制当 Node 跑，用户零安装；
// 开发环境回退系统 PATH 的 opencli。
// 安全：白名单二进制 + 写操作动词拦截（发布/关注/点赞等一律拒绝）。

const TIMEOUT_MS = 120_000
const OUT_CAP = 16_000
/** stdout 累积上限（字符）：超过即 kill——超出部分对 LLM 无意义，且防异常命令 GB 级输出撑爆内存 */
const STDOUT_MAX_CHARS = 256 * 1024
/** stderr 只保留末尾（exitHint 只看尾部 500 字符，无需全量驻留内存） */
const STDERR_KEEP_CHARS = 8_000

/** 写操作动词（出现即拒绝，铁律：agent 只读不替用户发内容） */
const WRITE_VERBS = new Set([
  'publish', 'follow', 'unfollow', 'like', 'favorite', 'comment', 'answer',
  'post', 'reply', 'reply-dm', 'delete', 'block', 'unblock', 'accept',
  'upvote', 'save', 'subscribe', 'connect', 'send', 'bookmark', 'unbookmark',
  'hide-reply', 'list-create', 'list-delete', 'list-add', 'list-add-batch',
  'list-remove', 'list-remove-batch', 'login', 'generate', 'describe', 'action',
  'task-create', 'task-claim', 'task-convert', 'task-delete', 'channel-create',
  'channel-join', 'message-send',
])

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
    const child = spawn(target.cmd, [...target.argsPrefix, ...args], { env: target.env })
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
    '通过用户本机已登录的浏览器会话读取网站内容（小红书/知乎/B站/Reddit/Twitter/微信公众号/HackerNews 等 100+ 站点，适合需要登录态的平台）。args 是 opencli 子命令参数数组，例如 ["xiaohongshu","search","关键词","--limit","5","-f","json"]、["zhihu","hot","-f","json"]、["bilibili","search","AI","-f","json"]。规则：只准用读取类命令（search/hot/read/note/question/video/comments/user/trending/timeline/download 等）；输出尽量带 "-f","json"；站点或命令不确定时先 ["list"] 查看支持的命令。',
    z.object({
      args: z
        .array(z.string())
        .min(1)
        .describe('opencli 子命令与参数（不含 "opencli" 本身）'),
    }),
    async (args, ctx) => {
      const { args: cliArgs } = args as { args: string[] }

      const writeVerb = cliArgs.find((a) => WRITE_VERBS.has(a))
      if (writeVerb) {
        return {
          ok: false,
          error: 'write_op_blocked',
          hint: `"${writeVerb}" 是写操作（发布/关注/点赞等），本应用禁止 agent 替用户写内容；如需请用户手动操作`,
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
