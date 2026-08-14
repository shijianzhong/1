import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { registerTool } from '../registry'
import { logger } from '../../logger'
import { getBuiltinTemplatesDir, getTemplatesPath } from '../../storage/paths'

// —— 配图渲染（内容生产 §2.2，范式B：spawn Chrome headless）——
// 流程：读 poster HTML 模板（builtin overlay：用户层有则用，无则回退 builtin 出厂源）
//   → 写入临时 HTML（填入文案变量）→ Chrome headless --screenshot 截图 → 返回 PNG 路径。
// 不依赖外部 .sh 脚本：跨平台 Chrome 检测 + 4 件套 flags 内联，自包含随包分发。
// 模板路径用 file://（Chrome 能读本地 HTML+CSS+图片）。
// 错误策略：无 Chrome/无模板 → 结构化错误 JSON；截图失败抛走 registry。
// 错误文案带 messageKey（铁律 T2）。

const TIMEOUT_MS = 60_000
const DEFAULT_HEIGHT = 630

/** 跨平台 Chrome 路径检测（仿 poster-screenshot.sh） */
function findChrome(): string | null {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  // 兜底：PATH 查找
  for (const name of ['google-chrome', 'chromium', 'chromium-browser', 'chrome']) {
    try {
      const which = spawn('which', [name], { shell: true })
      // 同步探测太重，跳过——CLI 用户一般装了上述候选之一
      void which
    } catch {
      // ignore
    }
  }
  return null
}

/** 解析模板路径：用户可写层优先，回退 builtin 出厂源 */
function resolveTemplate(name: string): string | null {
  const userPath = join(getTemplatesPath(), name)
  if (existsSync(userPath)) return userPath
  const builtinPath = join(getBuiltinTemplatesDir(), name)
  if (existsSync(builtinPath)) return builtinPath
  return null
}

interface ChromeOutcome {
  code: number | null
  stderr: string
}

function runChrome(
  chrome: string,
  args: string[],
  signal: AbortSignal | undefined,
): Promise<ChromeOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(chrome, args, { env: process.env, detached: true })
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
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4_000)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ code, stderr })
    })
  })
}

export function registerPosterTools(): void {
  registerTool(
    'poster_render',
    '用 Chrome headless 把 poster HTML 模板渲染成 PNG 配图（封面 1200×630 / 引子图 1200×675 / 长图自定义高）。模板走 builtin overlay：用户改过的副本优先，否则用出厂内置模板。文案通过变量填入模板。产出 PNG 落到输出路径（通常 Obsidian vault 当日目录）。',
    z.object({
      template: z.string().default('wechat-poster.html').describe('模板文件名，默认 wechat-poster.html'),
      outPath: z.string().describe('输出 PNG 绝对路径（如 ~/sh/DailyNotes/2026-08-14/xxx-cover.png）'),
      /** 变量键值，替换模板里的 {{key}} 占位 */
      vars: z.record(z.string(), z.string()).describe('填入模板的变量键值，替换 {{key}} 占位'),
      height: z.number().int().optional().describe('截图窗口高度，默认 630（封面）；引子图传 675，长图自定义'),
    }),
    async (args, ctx) => {
      const { template, outPath, vars, height } = args as {
        template: string
        outPath: string
        vars: Record<string, string>
        height?: number
      }
      // —— 1. 解析模板（overlay）——
      const templatePath = resolveTemplate(template)
      if (!templatePath) {
        return {
          ok: false,
          error: 'template_missing',
          messageKey: 'errors.tools.poster_template_missing',
          hint: `模板 ${template} 不存在；用户层 config/templates 与 builtin 出厂源都没有`,
        }
      }
      // —— 2. 读模板 + 填变量 → 临时 HTML ——
      let html: string
      try {
        html = await readFile(templatePath, 'utf8')
      } catch {
        return {
          ok: false,
          error: 'template_read_failed',
          messageKey: 'errors.tools.poster_template_missing',
        }
      }
      let filled = html
      for (const [k, v] of Object.entries(vars)) {
        filled = filled.split(`{{${k}}}`).join(v)
      }
      const tmpDir = join(process.env.TMPDIR || `${homedir()}/.tmp`, 'one-poster')
      await mkdir(tmpDir, { recursive: true })
      const tmpHtml = join(tmpDir, `poster-${randomUUID()}.html`)
      await writeFile(tmpHtml, filled, 'utf8')
      // 输出目录建好
      await mkdir(dirname(outPath), { recursive: true })

      // —— 3. Chrome headless 截图（4 件套）——
      const chrome = findChrome()
      if (!chrome) {
        return {
          ok: false,
          error: 'chrome_not_found',
          messageKey: 'errors.tools.poster_render_failed',
          hint: '找不到 Chrome/Chromium，请用户安装 Google Chrome',
        }
      }
      const h = height ?? DEFAULT_HEIGHT
      logger.info(`[poster] chrome=${chrome} html=${tmpHtml} out=${outPath} h=${h}`)
      let outcome: ChromeOutcome
      try {
        outcome = await runChrome(
          chrome,
          [
            '--headless=new',
            '--hide-scrollbars',
            '--force-device-scale-factor=1',
            `--window-size=1200,${h}`,
            `--screenshot=${outPath}`,
            `file://${tmpHtml}`,
          ],
          ctx.signal,
        )
      } catch (e) {
        throw e // 超时/abort 交 registry
      }
      // Chrome 常因 display 噪音退出码非0但图已生成，验文件为准
      await new Promise((r) => setTimeout(r, 500))
      if (!existsSync(outPath)) {
        // 等落盘（最多 3s）
        for (let i = 0; i < 6; i++) {
          if (existsSync(outPath)) break
          await new Promise((r) => setTimeout(r, 500))
        }
      }
      if (!existsSync(outPath)) {
        return {
          ok: false,
          error: 'screenshot_failed',
          messageKey: 'errors.tools.poster_render_failed',
          hint: 'Chrome 已执行但未产出 PNG，检查模板 HTML 是否有语法错误',
          chromeStderr: outcome.stderr.slice(-500),
        }
      }
      return { ok: true, outPath, template: templatePath }
    },
  )
}
