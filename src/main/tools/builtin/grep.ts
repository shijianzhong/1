import { z } from 'zod'
import { readFile, readdir } from 'node:fs/promises'
import { join, extname, resolve } from 'node:path'
import { registerTool } from '../registry'

// —— grep（任务计划 Task 2）——
// 纯 TS 正则代码搜索：Rust regex 语法子集（JS RegExp 近似）。
// 搜索根 = ctx.workspaceRoot（无 workspaceRoot 返回 no_workspace 引导选目录）。
// 性能边界：MAX_WALK 文件数、GREP_FILE_EXTS 扩展名白名单、truncated 返回。

const MAX_WALK = 3000
const MAX_RESULTS = 30
const MAX_SNIPPET = 200
const GREP_FILE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.md', '.json', '.yaml', '.yml', '.txt']

const GrepSchema = z.object({
  pattern: z.string().min(1).describe('Search pattern (regex)'),
  path: z.string().optional().describe('Directory or file path relative to workspace root (default: whole workspace)'),
  glob: z.string().optional().describe('File glob filter, e.g. "*.ts", "src/**/*.tsx"'),
  output_mode: z.enum(['files_with_matches', 'content', 'count']).default('content'),
  maxResults: z.number().int().min(1).max(100).default(MAX_RESULTS),
})

interface GrepMatch {
  path: string
  line: number
  content: string
}

async function walkFiles(absDir: string, out: string[], root: string): Promise<void> {
  if (out.length >= MAX_WALK) return
  let entries
  try {
    entries = await readdir(absDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (out.length >= MAX_WALK) return
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const full = join(absDir, e.name)
    if (e.isDirectory()) await walkFiles(full, out, root)
    else out.push(full)
  }
}

function matchesGlob(filePath: string, glob: string): boolean {
  // 简化 glob：* 任意字符（不跨目录），** 任意字符（跨目录）
  const rel = filePath.replace(/\\/g, '/')
  const regex = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
  return new RegExp(`^${regex}$`).test(rel)
}

export function registerGrepTool(): void {
  registerTool(
    'grep',
    '在项目目录（workspaceRoot）内按正则搜索文件内容。支持 glob 过滤、文件列表/内容/计数三种输出模式。',
    GrepSchema,
    async (args, ctx) => {
      const input = args as z.infer<typeof GrepSchema>
      if (!ctx?.workspaceRoot) {
        return { ok: false, error: 'no_workspace', hint: '当前会话未设项目路径——请在当前页面顶部选择项目目录' }
      }
      const searchRoot = input.path
        ? resolve(ctx.workspaceRoot, input.path)
        : ctx.workspaceRoot

      let pattern: RegExp
      try {
        pattern = new RegExp(input.pattern, 'i')
      } catch (e) {
        return { ok: false, error: 'invalid_regex', hint: `Invalid regex pattern: ${input.pattern}` }
      }

      const files: string[] = []
      await walkFiles(searchRoot, files, ctx.workspaceRoot)
      const truncated = files.length >= MAX_WALK

      const results: GrepMatch[] = []
      let filesWithMatches = 0
      let totalMatches = 0

      for (const file of files) {
        if (results.length >= input.maxResults && input.output_mode === 'content') break
        if (input.glob && !matchesGlob(file, input.glob)) continue
        if (!GREP_FILE_EXTS.includes(extname(file).toLowerCase())) continue

        let text: string
        try {
          text = await readFile(file, 'utf-8')
        } catch {
          continue
        }
        const lines = text.split('\n')
        const fileMatches: GrepMatch[] = []
        for (let i = 0; i < lines.length; i++) {
          if (pattern.test(lines[i])) {
            fileMatches.push({
              path: file,
              line: i + 1,
              content: lines[i].trim().slice(0, MAX_SNIPPET),
            })
            totalMatches++
          }
        }
        if (fileMatches.length > 0) {
          filesWithMatches++
          if (input.output_mode === 'content') {
            results.push(...fileMatches.slice(0, 10))
          }
        }
      }

      if (input.output_mode === 'files_with_matches') {
        // 重新走一遍 walk 收集所有含匹配的文件（output_mode 不是 content 时 results 为空）
        const matchedFiles: string[] = []
        for (const file of files) {
          if (input.glob && !matchesGlob(file, input.glob)) continue
          if (!GREP_FILE_EXTS.includes(extname(file).toLowerCase())) continue
          let text: string
          try {
            text = await readFile(file, 'utf-8')
          } catch {
            continue
          }
          if (pattern.test(text)) matchedFiles.push(file)
        }
        return { ok: true, count: matchedFiles.length, files: matchedFiles, truncated }
      }
      if (input.output_mode === 'count') {
        return { ok: true, filesWithMatches, totalMatches, truncated }
      }
      return { ok: true, matches: results.slice(0, input.maxResults), truncated }
    },
  )
}
