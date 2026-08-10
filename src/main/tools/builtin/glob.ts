import { z } from 'zod'
import { readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { registerTool } from '../registry'

// —— glob（任务计划 Task 3）——
// 文件模式匹配（Glob 等价物）。搜索根 = ctx.workspaceRoot。
// 匹配基于相对路径（支持 **/src/**/*.ts 这类跨目录模式）。

const MAX_WALK = 5000
const TRUNCATE_HINT = `查找被截断（扫描达 ${MAX_WALK} 文件上限）。缩小 path（限定子目录）或用更具体的 pattern 后重试。`
const MAX_RESULTS = 100

const GlobSchema = z.object({
  pattern: z.string().min(1).describe('Glob pattern, e.g. "*.ts", "src/**/*.tsx", "**/*.test.ts"'),
  path: z.string().optional().describe('Directory relative to workspace root (default: whole workspace)'),
  maxResults: z.number().int().min(1).max(200).default(MAX_RESULTS),
})

function globToRegex(pattern: string): RegExp {
  // 逐段解析：先按 / 分割，** 单独成段时匹配 0+ 路径段，** 内嵌段匹配任意字符
  const segments = pattern.split('/')
  const regexParts: string[] = []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (seg === '**') {
      // ** 成段：匹配 0 个或多个路径段（含空）
      regexParts.push('(?:[^/]+/)*')
    } else {
      // 段内：转义特殊字符，* → 不跨目录，? → 单字符，** → 任意字符
      const part = seg
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
      regexParts.push(part)
      if (i < segments.length - 1) regexParts.push('/')
    }
  }
  // 合并：如果最后是 **/ 产生的 (?:[^/]+/)*，吃掉多余末尾 /
  const regexStr = regexParts.join('').replace(/\/$/, '')
  return new RegExp(`^${regexStr}$`)
}

async function walkGlob(
  absDir: string,
  root: string,
  out: string[],
  maxWalk: number,
): Promise<void> {
  if (out.length >= maxWalk) return
  let entries
  try {
    entries = await readdir(absDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (out.length >= maxWalk) return
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const full = join(absDir, e.name)
    if (e.isDirectory()) await walkGlob(full, root, out, maxWalk)
    else out.push(full)
  }
}

export function registerGlobTool(): void {
  registerTool(
    'glob',
    '在项目目录（workspaceRoot）内按 glob 模式查找文件路径。支持 ** 跨目录匹配。',
    GlobSchema,
    async (args, ctx) => {
      const input = args as z.infer<typeof GlobSchema>
      if (!ctx?.workspaceRoot) {
        return { ok: false, error: 'no_workspace', hint: '当前会话未设项目路径——请在当前页面顶部选择项目目录' }
      }
      const searchRoot = input.path
        ? resolve(ctx.workspaceRoot, input.path)
        : ctx.workspaceRoot

      let pattern: RegExp
      try {
        pattern = globToRegex(input.pattern)
      } catch {
        return { ok: false, error: 'invalid_glob', hint: `Invalid glob pattern: ${input.pattern}` }
      }

      const files: string[] = []
      await walkGlob(searchRoot, ctx.workspaceRoot, files, MAX_WALK)
      const truncated = files.length >= MAX_WALK

      const matched: string[] = []
      for (const file of files) {
        const rel = relative(ctx.workspaceRoot, file).replace(/\\/g, '/')
        // ** 语义：0 个或多个路径段，src/**/*.ts 应匹配 src/a.ts
        if (pattern.test(rel)) {
          matched.push(file)
        }
      }

      const isTruncated = truncated || matched.length > input.maxResults
      return {
        ok: true,
        count: matched.length,
        files: matched.slice(0, input.maxResults),
        truncated: isTruncated,
        hint: isTruncated ? TRUNCATE_HINT : undefined,
      }
    },
  )
}
