import { z } from 'zod'
import { errPayload, notAllowedPayload, resolveConfined, writeFileAtomic } from './file'
import { registerTool, type ToolContext } from '../registry'
import { readFile } from 'node:fs/promises'

// —— str_replace_editor（Claude Code 等价物，任务计划 Task 1）——
// 纯 TS 行级编辑：view / str_replace / insert。路径经 resolveConfined 围栏
// （workspaceRoot 优先），写操作原子落盘。不抛异常，错误返回结构化 payload。
// 无 workspaceRoot 时 view 用空数组（view 允许全局只读），str_replace/insert 返回
// no_workspace 引导用户选目录（Task 0 步骤 10 的 no_workspace UX 指引）。

const VIEW_MAX_LINES = 2000

const CommandSchema = z.discriminatedUnion('command', [
  z.object({
    command: z.literal('view'),
    path: z.string().min(1).describe('File or directory path (absolute or relative to project root)'),
    view_range: z
      .tuple([z.number().int(), z.number().int()])
      .optional()
      .describe('1-based [start, end] line range; -1 = to end'),
  }),
  z.object({
    command: z.literal('str_replace'),
    path: z.string().min(1).describe('File path (absolute or relative to project root)'),
    old_str: z.string().min(1).describe('Exact string to replace (must match file content exactly)'),
    new_str: z.string().describe('Replacement string'),
  }),
  z.object({
    command: z.literal('insert'),
    path: z.string().min(1).describe('File path (absolute or relative to project root)'),
    insert_line: z.number().int().min(0).describe('Insert after this 0-based line number (0 = before first line)'),
    new_str: z.string().describe('Content to insert'),
  }),
])

type Command = z.infer<typeof CommandSchema>

function noWorkspacePayload(): Record<string, unknown> {
  return {
    ok: false,
    error: 'no_workspace',
    hint: '当前会话未设项目路径——请在当前页面顶部选择项目目录（首页或编辑器页均有项目路径选择器）',
  }
}

async function handleView(input: Extract<Command, { command: 'view' }>, ctx?: ToolContext): Promise<unknown> {
  const abs = resolveConfined(input.path, ctx?.workspaceRoot)
  if (!abs) return notAllowedPayload(input.path, ctx?.workspaceRoot)
  try {
    const stat = await import('node:fs/promises').then((m) => m.stat(abs))
    if (stat.isDirectory()) {
      const { readdir } = await import('node:fs/promises')
      const entries = await readdir(abs, { withFileTypes: true })
      const list = entries
        .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
        .map((e) => `${e.isDirectory() ? '[dir] ' : ''}${e.name}`)
      return { ok: true, path: abs, kind: 'directory', entries: list }
    }
    let text = await readFile(abs, 'utf-8')
    const lines = text.split('\n')
    let truncated = false
    let start = 1
    let end = lines.length
    if (input.view_range) {
      const [s, e] = input.view_range
      start = Math.max(1, s)
      end = e === -1 ? lines.length : Math.min(lines.length, e)
      if (start > end) return { ok: false, error: 'invalid_range', hint: `view_range [${s}, ${e}] out of bounds (1..${lines.length})` }
      text = lines.slice(start - 1, end).join('\n')
    }
    if (lines.length > VIEW_MAX_LINES) {
      truncated = true
      text = lines.slice(0, VIEW_MAX_LINES).join('\n')
    }
    return {
      ok: true,
      path: abs,
      kind: 'file',
      totalLines: lines.length,
      shownLines: text.split('\n').length,
      truncated,
      content: text,
    }
  } catch (error) {
    return errPayload(error)
  }
}

async function handleStrReplace(
  input: Extract<Command, { command: 'str_replace' }>,
  ctx?: ToolContext,
): Promise<unknown> {
  if (!ctx?.workspaceRoot) return noWorkspacePayload()
  const abs = resolveConfined(input.path, ctx.workspaceRoot)
  if (!abs) return notAllowedPayload(input.path, ctx.workspaceRoot)
  try {
    const text = await readFile(abs, 'utf-8')
    if (!text.includes(input.old_str)) {
      return { ok: false, error: 'no_match', hint: 'old_str not found in file (must match exactly, including whitespace)' }
    }
    const firstIdx = text.indexOf(input.old_str)
    const secondIdx = text.indexOf(input.old_str, firstIdx + 1)
    if (secondIdx !== -1) {
      return { ok: false, error: 'multiple_match', hint: 'old_str matches multiple locations — make it unique or use view to disambiguate' }
    }
    const next = text.replace(input.old_str, input.new_str)
    await writeFileAtomic(abs, next)
    return { ok: true, path: abs }
  } catch (error) {
    return errPayload(error)
  }
}

async function handleInsert(
  input: Extract<Command, { command: 'insert' }>,
  ctx?: ToolContext,
): Promise<unknown> {
  if (!ctx?.workspaceRoot) return noWorkspacePayload()
  const abs = resolveConfined(input.path, ctx.workspaceRoot)
  if (!abs) return notAllowedPayload(input.path, ctx.workspaceRoot)
  try {
    const text = await readFile(abs, 'utf-8')
    const lines = text.split('\n')
    const insertAt = Math.min(input.insert_line, lines.length)
    const next = [...lines.slice(0, insertAt), input.new_str, ...lines.slice(insertAt)].join('\n')
    await writeFileAtomic(abs, next)
    return { ok: true, path: abs, insertedAfterLine: insertAt }
  } catch (error) {
    return errPayload(error)
  }
}

export function registerStrReplaceEditorTool(): void {
  registerTool(
    'str_replace_editor',
    '查看/精确替换/插入文件行级内容。view 支持目录列表与文件 view_range；str_replace 要求 old_str 唯一匹配；insert 在指定行后插入。仅可在已设项目目录（workspaceRoot）内操作。',
    CommandSchema,
    async (args, ctx) => {
      const cmd = args as Command
      if (cmd.command === 'view') return handleView(cmd, ctx)
      if (cmd.command === 'str_replace') return handleStrReplace(cmd, ctx)
      return handleInsert(cmd, ctx)
    },
    'always',
  )
}
