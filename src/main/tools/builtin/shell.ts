import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { z } from 'zod'
import { registerTool } from '../registry'
import { logger } from '../../logger'

// —— shell_run 工具（P1 · task.md 7.1）——
// 让 AI 在用户确认后执行 shell 命令（安装 CLI、跑系统级操作、驱动无 MCP 封装的上游工具）。
// 复刻 opencli_run / skill_run_script 的 async spawn 纪律（铁律 23）。
// 安全：approvalMode='always'（P0 闸门）+ 可选「本会话允许」跳过后续弹窗
// + DANGER_PATTERNS 辅助硬拦（preCheck，会话放行也不绕过）+ env 敏感值过滤。
// 正则黑名单可被绕过，真正边界是 P0 确认（或会话级信任）+ 用户知情。

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_SEC = 300
const OUT_CAP = 16_000
const STDOUT_MAX_CHARS = 256 * 1024
const STDERR_KEEP_CHARS = 8_000

/** 辅助硬拦：明显自杀式命令。正则黑名单可被绕过，不是安全边界。
 *  在审批前通过 preCheck 钩子检查，避免"用户批准后才拦"的 UX 矛盾。 */
const DANGER_PATTERNS = [
  /\brm\s+-rf\s+\/\s*$/,
  /\brm\s+-rf\s+\/\s*;/,
  /\bmkfs\b/,
  /\bdd\s+if=.*of=\/dev\//,
  /:\(\)\{.*\|\:&\};:/,
  /\bshutdown\b/,
  /\breboot\b/,
]

interface ShellOutcome {
  code: number | null
  stdout: string
  stderr: string
}

/** Promise 化 spawn：自建 timer + SIGKILL，不使用 spawn() 的 timeout 选项（Node child_process 无该字段）。
 *  detached: true → 子进程成为独立进程组 leader，便于 process.kill(-pid) 组杀整个进程树。 */
function runShell(
  command: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number },
): Promise<ShellOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      env: opts.env,
      shell: true,
      detached: true,
    })

    let stdout = ''
    let stderr = ''
    let killed = false

    const cleanup = (): void => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }

    const timer = setTimeout(() => {
      killed = true
      // 进程组 kill——kill -PGID 杀整个进程树（含 nohup 子进程）
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      reject(new Error('timeout'))
    }, opts.timeoutMs)
    timer.unref?.()

    const onAbort = (): void => {
      killed = true
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      reject(opts.signal?.reason ?? new Error('aborted'))
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
      if (stdout.length > STDOUT_MAX_CHARS) {
        cleanup()
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
        reject(new Error(`stdout_limit_exceeded: output exceeded ${STDOUT_MAX_CHARS} chars`))
      }
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-STDERR_KEEP_CHARS)
    })
    child.on('error', (e) => {
      cleanup()
      reject(e)
    })
    child.on('close', (code) => {
      cleanup()
      if (killed) return // timer/abort 已 reject，不再 resolve
      resolve({ code, stdout, stderr })
    })
  })
}

/** env 过滤：以 _KEY / _SECRET / _TOKEN / _ID 结尾的变量置空，避免 API key 等通过 env 命令泄露 */
function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const filtered = { ...env }
  for (const key of Object.keys(filtered)) {
    if (/_KEY$|_SECRET$|_TOKEN$|_ID$/i.test(key)) {
      filtered[key] = ''
    }
  }
  return filtered
}

export function registerShellTools(): void {
  registerTool(
    'shell_run',
    'Execute a shell command after user approval. Default cwd is the user home. '
      + 'Stdout truncated to 16000 chars. Obvious destructive patterns are blocked hard. '
      + 'Prefer dedicated tools/MCP for frequent read-only CLI; do not use shell to bypass them.',
    z.object({
      command: z.string().describe('Shell command to run'),
      cwd: z
        .string()
        .optional()
        .describe('Working directory (default: user home). No path fence — security carried by approval.'),
      timeoutSec: z
        .number()
        .int()
        .min(1)
        .max(300)
        .optional()
        .describe('Timeout seconds (default 120, max 300)'),
    }),
    async (args, ctx) => {
      const { command, cwd, timeoutSec } = args as {
        command: string
        cwd?: string
        timeoutSec?: number
      }

      const safeEnv = sanitizeEnv(process.env)
      const effectiveTimeout = Math.min(timeoutSec ?? DEFAULT_TIMEOUT_MS / 1000, MAX_TIMEOUT_SEC) * 1000
      const workDir = cwd ?? ctx?.workspaceRoot ?? homedir()

      logger.info(`[shell] run: ${command}（cwd=${workDir}, timeout=${effectiveTimeout}ms）`)

      let outcome: ShellOutcome
      try {
        outcome = await runShell(command, {
          cwd: workDir,
          env: safeEnv,
          signal: ctx.signal,
          timeoutMs: effectiveTimeout,
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg === 'timeout') {
          return {
            ok: false,
            error: 'timeout',
            messageKey: 'errors.tools.shell_timeout',
            hint: `Command timed out after ${effectiveTimeout / 1000}s`,
          }
        }
        if (msg.startsWith('stdout_limit_exceeded')) {
          return {
            ok: false,
            error: 'stdout_limit_exceeded',
            messageKey: 'errors.tools.shell_stdout_limit',
            hint: `Output exceeded ${Math.round(STDOUT_MAX_CHARS / 1024)}KB limit. Narrow the query or redirect to a file.`,
          }
        }
        if (msg.includes('ENOENT')) {
          return {
            ok: false,
            error: 'shell_not_found',
            messageKey: 'errors.tools.shell_not_found',
            hint: 'Shell binary not available on this system.',
          }
        }
        throw e // 交给 registry 重试/错误 JSON（铁律 11）
      }

      const stdout = outcome.stdout.slice(0, OUT_CAP)
      logger.info(`[shell] done: exit=${outcome.code}, stdout=${outcome.stdout.length} chars`)

      return {
        ok: outcome.code === 0,
        output: stdout,
        exitCode: outcome.code,
        truncated: outcome.stdout.length > OUT_CAP,
        stderr: outcome.stderr.slice(-500),
        messageKey: outcome.code === 0 ? undefined : 'errors.tools.shell_nonzero_exit',
      }
    },
    'always', // 每次执行都需用户确认（依赖 P0 闸门）
    {
      // preCheck 在审批前硬拦 DANGER_PATTERNS
      // 避免"用户批准后才拦"的 UX 矛盾
      preCheck: (args) => {
        const { command } = args as { command: string }
        for (const pattern of DANGER_PATTERNS) {
          if (pattern.test(command)) {
            return {
              ok: false,
              error: 'dangerous_command_blocked',
              messageKey: 'errors.tools.shell_danger_command',
            }
          }
        }
        return { ok: true }
      },
    },
  )
}
