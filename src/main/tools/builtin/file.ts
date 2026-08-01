import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { readJsonFile } from '../../storage/json-store'
import { getUserDataDir } from '../../storage/paths'
import { registerTool } from '../registry'

// —— 文件工具（阶段 7.1c：file_write / file_read / file_search）——
// 路径围栏：只允许指定根目录内的读写，防 LLM 误写系统路径。
//   - 默认根：~/sh/DailyNotes（Obsidian vault）+ userData/exports
//   - 扩展：userData/config/file-roots.json（数组或 { roots: [] }）
//   - 覆盖：ONE_FILE_ROOTS env（JSON 数组，整体替换全部根，测试隔离用）
// 写操作：临时文件 + rename 原子落盘（§11.4 防半截文件），自动建父目录，支持 append。
// 全量异步（fs/promises）：文件工具被 agent 循环高频调用，同步 I/O 会阻塞主进程
// 事件循环冻结桌面 UI——尤其 file_search 逐文件读内容匹配（最多扫 SEARCH_MAX_WALK 个）。
// I/O 失败返回结构化错误 payload 不抛异常（抛异常会触发 executeTool 重试 3 次，
// 对 not_found/permission 这类确定性错误重试无意义）。

const DEFAULT_VAULT = join(homedir(), 'sh', 'DailyNotes')
const SEARCH_MAX_WALK = 2_000
const SEARCH_MAX_RESULTS = 30
const CONTENT_SCAN_EXTS = ['.md', '.txt', '.json', '.log']
const CONTENT_MAX_CHARS = 100_000
const SNIPPET_MAX_CHARS = 200

const FILE_ROOTS_CONFIG = (): string => join(getUserDataDir(), 'config', 'file-roots.json')

const WriteSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  mode: z.enum(['overwrite', 'append']).default('overwrite'),
})

const ReadSchema = z.object({
  path: z.string().min(1),
})

const SearchSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().min(1).max(100).default(SEARCH_MAX_RESULTS),
})

/** 允许根目录列表：env 整体覆盖 > 默认 + config 扩展 */
export function getFileRoots(): string[] {
  const envRaw = process.env.ONE_FILE_ROOTS
  if (envRaw) {
    try {
      const parsed: unknown = JSON.parse(envRaw)
      if (Array.isArray(parsed)) {
        return parsed.filter((r): r is string => typeof r === 'string').map((r) => resolve(expandHome(r)))
      }
    } catch {
      // env 解析失败按无覆盖处理
    }
  }
  const roots = [resolve(DEFAULT_VAULT), resolve(join(getUserDataDir(), 'exports'))]
  try {
    const cfg = readJsonFile<string[] | { roots?: string[] }>(FILE_ROOTS_CONFIG(), [])
    const extra = Array.isArray(cfg) ? cfg : (cfg.roots ?? [])
    for (const r of extra) if (typeof r === 'string') roots.push(resolve(expandHome(r)))
  } catch {
    // config 缺失/损坏不阻断默认根
  }
  return roots
}

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

/**
 * 把 LLM 给的 path 限定在允许根目录内。
 * 相对路径相对首个根解析。返回 null = 越界（含 ../ 逃逸，resolve 已归一化）。
 */
function resolveConfined(rawPath: string): string | null {
  const roots = getFileRoots()
  const abs = rawPath.startsWith('/') || rawPath.startsWith('~')
    ? resolve(expandHome(rawPath))
    : resolve(join(roots[0] ?? getUserDataDir(), rawPath))
  for (const root of roots) {
    if (abs === root || abs.startsWith(root + sep)) return abs
  }
  return null
}

function notAllowedPayload(rawPath: string): Record<string, unknown> {
  const roots = getFileRoots().map((r) => `  - ${r}`).join('\n')
  return {
    ok: false,
    error: 'path_not_allowed',
    hint: `路径「${rawPath}」不在允许的根目录内：\n${roots}\n相对路径按首个根目录解析。`,
  }
}

function errPayload(error: unknown): Record<string, unknown> {
  const msg = error instanceof Error ? error.message : String(error)
  let code = 'io_error'
  if (msg.includes('ENOENT')) code = 'not_found'
  else if (msg.includes('EACCES') || msg.includes('EPERM')) code = 'permission_denied'
  else if (msg.includes('EISDIR')) code = 'is_directory'
  return { ok: false, error: code, hint: msg }
}

/** 原子写：临时文件 + rename（§11.4） */
async function writeFileAtomic(absPath: string, content: string): Promise<void> {
  const dir = resolve(absPath, '..')
  await mkdir(dir, { recursive: true })
  const tmp = `${absPath}.${Date.now()}.tmp`
  await writeFile(tmp, content, 'utf-8')
  await rename(tmp, absPath)
}

/** 递归收集文件（跳过隐藏目录与 node_modules，限 SEARCH_MAX_WALK） */
async function walkFiles(absDir: string, out: string[]): Promise<void> {
  if (out.length >= SEARCH_MAX_WALK) return
  let entries
  try {
    entries = await readdir(absDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (out.length >= SEARCH_MAX_WALK) return
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const full = join(absDir, e.name)
    if (e.isDirectory()) await walkFiles(full, out)
    else out.push(full)
  }
}

export function registerFileTools(): void {
  registerTool(
    'file_write',
    '写入本地文件（限允许的根目录内，默认 Obsidian vault 与 userData/exports）。自动创建父目录；临时文件 + rename 原子落盘；mode=append 追加到末尾。',
    WriteSchema,
    async (args) => {
      const input = args as z.infer<typeof WriteSchema>
      const abs = resolveConfined(input.path)
      if (!abs) return notAllowedPayload(input.path)
      try {
        let finalContent = input.content
        if (input.mode === 'append' && existsSync(abs)) {
          finalContent = (await readFile(abs, 'utf-8')) + input.content
        }
        await writeFileAtomic(abs, finalContent)
        return { ok: true, path: abs, bytes: Buffer.byteLength(finalContent, 'utf-8') }
      } catch (error) {
        return errPayload(error)
      }
    },
  )

  registerTool(
    'file_read',
    '读取本地文件内容（限允许的根目录内）。大文件截断返回并标注 truncated。',
    ReadSchema,
    async (raw) => {
      const input = raw as z.infer<typeof ReadSchema>
      const abs = resolveConfined(input.path)
      if (!abs) return notAllowedPayload(input.path)
      try {
        let text = await readFile(abs, 'utf-8')
        let truncated = false
        if (text.length > CONTENT_MAX_CHARS) {
          text = text.slice(0, CONTENT_MAX_CHARS)
          truncated = true
        }
        return { ok: true, path: abs, content: text, truncated }
      } catch (error) {
        return errPayload(error)
      }
    },
  )

  registerTool(
    'file_search',
    '在允许的根目录（默认 Obsidian vault）内按关键词搜索：文件名或内容任一命中即返回（OR 匹配），递归子目录。返回文件清单与命中行片段。',
    SearchSchema,
    async (raw) => {
      const input = raw as z.infer<typeof SearchSchema>
      const needle = input.query.toLowerCase()
      const files: Array<{ title: string; path: string; matches: Array<{ line: number; snippet: string }> }> = []
      let scanned = 0

      for (const root of getFileRoots()) {
        if (files.length >= input.maxResults) break
        if (!existsSync(root)) continue
        const walked: string[] = []
        // 逐文件 await 读盘：事件循环在 I/O 间隙可喘息，不冻结 UI（P1-6 异步化）
        await walkFiles(root, walked)
        scanned += walked.length
        for (const file of walked) {
          if (files.length >= input.maxResults) break
          const title = basename(file, extname(file))
          const nameHit = title.toLowerCase().includes(needle)
          const matches: Array<{ line: number; snippet: string }> = []
          if (CONTENT_SCAN_EXTS.includes(extname(file).toLowerCase())) {
            let text: string
            try {
              text = await readFile(file, 'utf-8')
            } catch {
              continue
            }
            if (text.length <= CONTENT_MAX_CHARS) {
              const lines = text.split('\n')
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].toLowerCase().includes(needle)) {
                  matches.push({ line: i + 1, snippet: lines[i].trim().slice(0, SNIPPET_MAX_CHARS) })
                  if (matches.length >= 5) break
                }
              }
            }
          }
          if (nameHit || matches.length > 0) files.push({ title, path: file, matches })
        }
      }
      return { ok: true, count: files.length, files, scannedFiles: scanned }
    },
  )
}
