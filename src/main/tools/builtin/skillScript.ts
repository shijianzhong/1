import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { extname, isAbsolute, resolve, sep } from 'node:path'
import { z } from 'zod'
import { registerTool } from '../registry'
import { listSkills } from '../../storage/models'
import { listSkillScripts, resolveScriptsDir } from '../../skills/provider'
import { logger } from '../../logger'

// —— skill_run_script（铁律23：脚本执行必须 async，同步 spawn 会冻死事件循环）——
// 复用 opencli_run 趟出的 async spawn 纪律：Promise 化 + 超时 SIGKILL + AbortSignal 联动
// kill + stdout 累积上限防内存爆 + stderr 只留尾部 + 输出截断标注。
// 安全：脚本路径严格限定在该技能解压目录 scripts/ 内（拒绝 ../ 与绝对路径穿越）。

const TIMEOUT_MS = 60_000
const OUT_CAP = 16_000
/** stdout 累积上限：超过即 kill（防异常脚本 GB 级输出撑爆内存） */
const STDOUT_MAX_CHARS = 256 * 1024
const STDERR_KEEP_CHARS = 4_000

interface ScriptOutcome {
  code: number | null
  stdout: string
  stderr: string
}

interface Interpreter {
  cmd: string
  env?: NodeJS.ProcessEnv
}

/** 按扩展名选解释器；.js 用 ELECTRON_RUN_AS_NODE 让应用主二进制当 Node 跑（零依赖，同 opencli vendor） */
function interpreterFor(scriptAbs: string): Interpreter | null {
  switch (extname(scriptAbs).toLowerCase()) {
    case '.py':
      return { cmd: 'python3' }
    case '.sh':
    case '.bash':
      return { cmd: 'bash' }
    case '.js':
    case '.mjs':
    case '.cjs':
      return { cmd: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
    default:
      return null
  }
}

function runScript(
  interpreter: Interpreter,
  scriptAbs: string,
  scriptArgs: string[],
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<ScriptOutcome> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(interpreter.cmd, [scriptAbs, ...scriptArgs], {
      cwd,
      env: interpreter.env ?? process.env,
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
        reject(new Error('stdout_limit_exceeded'))
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
      resolvePromise({ code, stdout, stderr })
    })
  })
}

export function registerSkillScriptTools(): void {
  registerTool(
    'skill_run_script',
    '执行已注入技能包内 scripts/ 目录下的脚本（<skill> 块的 scripts: 行列出了可执行脚本）。用于技能自带的计算/抓取/转换等自动化步骤。script 填列出的脚本相对路径（如 analyze.py），args 为命令行参数数组。脚本在技能根目录运行，可用相对路径读 resources/ 下文件。只执行技能说明里出现的脚本，不要猜。',
    z.object({
      skill: z.string().describe('技能名称（<skill name="..."> 里的 name）'),
      script: z.string().describe('脚本相对路径（scripts/ 下，如 analyze.py 或 lib/util.sh）'),
      args: z.array(z.string()).optional().describe('传给脚本的命令行参数'),
    }),
    async (args, ctx) => {
      const { skill: skillRef, script, args: scriptArgs } = args as {
        skill: string
        script: string
        args?: string[]
      }

      const skill = listSkills().find((s) => s.id === skillRef || s.name === skillRef)
      if (!skill) {
        return { ok: false, error: 'skill_not_found', hint: `技能「${skillRef}」不存在，用已注入 <skill> 块里的 name` }
      }
      if (!skill.scriptPath) {
        return { ok: false, error: 'no_scripts', hint: `技能「${skill.name}」不带脚本` }
      }
      const scriptsDir = resolveScriptsDir(skill.scriptPath)
      if (!scriptsDir) {
        return { ok: false, error: 'no_scripts_dir', hint: `技能「${skill.name}」脚本目录异常` }
      }

      // 路径安全：拒绝绝对路径与 .. 穿越，解析后必须落在 scripts/ 内
      if (isAbsolute(script) || script.split(/[\\/]/).includes('..')) {
        return { ok: false, error: 'invalid_script_path', hint: 'script 必须是 scripts/ 目录内的相对路径' }
      }
      const scriptAbs = resolve(scriptsDir, script)
      if (scriptAbs !== scriptsDir && !scriptAbs.startsWith(scriptsDir + sep)) {
        return { ok: false, error: 'invalid_script_path', hint: 'script 必须是 scripts/ 目录内的相对路径' }
      }
      if (!existsSync(scriptAbs)) {
        return {
          ok: false,
          error: 'script_not_found',
          hint: `可用脚本：${listSkillScripts(skill).join(', ') || '（无）'}`,
        }
      }

      const interpreter = interpreterFor(scriptAbs)
      if (!interpreter) {
        return { ok: false, error: 'unsupported_script_type', hint: '支持 .py / .sh / .js 脚本' }
      }

      logger.info(`[skill-script] ${skill.name}: ${script} ${(scriptArgs ?? []).join(' ')}`)
      let outcome: ScriptOutcome
      try {
        // cwd = 技能根目录（scripts/ 的上级），脚本可相对读 resources/
        outcome = await runScript(
          interpreter,
          scriptAbs,
          scriptArgs ?? [],
          resolve(scriptsDir, '..'),
          ctx.signal,
        )
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        if (msg === 'timeout') {
          return { ok: false, error: 'timeout', hint: `脚本运行超过 ${TIMEOUT_MS / 1000}s 已终止，缩小输入或优化脚本后重试` }
        }
        if (msg === 'stdout_limit_exceeded') {
          return { ok: false, error: 'stdout_limit_exceeded', hint: `输出超过 ${Math.round(STDOUT_MAX_CHARS / 1024)}KB 上限已终止，让脚本精简输出后重试` }
        }
        if (msg.includes('ENOENT')) {
          return { ok: false, error: 'interpreter_not_found', hint: `系统缺少解释器（${interpreter.cmd}），请用户安装后重试` }
        }
        throw error // 交 registry 重试/错误 JSON（铁律11）
      }

      const stdout = outcome.stdout.slice(0, OUT_CAP)
      if (outcome.code === 0) {
        return { ok: true, output: stdout, truncated: outcome.stdout.length > OUT_CAP }
      }
      return {
        ok: false,
        error: `exit_${outcome.code ?? 'unknown'}`,
        hint: '脚本非零退出——可把 stderr 摘要告知用户',
        stderr: outcome.stderr.slice(-500),
      }
    },
  )
}
