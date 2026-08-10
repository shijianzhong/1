import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { registerStrReplaceEditorTool } from './strReplace'
import { clearTools, executeTool, listAgentToolDefs } from '../registry'

let tmpDir: string

beforeEach(() => {
  clearTools()
  tmpDir = mkdtempSync(join(tmpdir(), 'str-replace-test-'))
  registerStrReplaceEditorTool()
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

const approveAll = { onApprove: async () => ({ approved: true }) }

describe('str_replace_editor', () => {
  it('view 返回文件内容', async () => {
    const file = join(tmpDir, 'a.txt')
    writeFileSync(file, 'line1\nline2\nline3\n')
    const r = await executeTool('str_replace_editor', { command: 'view', path: file }, 'tu_1', { workspaceRoot: tmpDir, ...approveAll })
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(true)
    expect(data.content).toContain('line1')
    expect(data.totalLines).toBe(4)
  })

  it('view 目录返回列表', async () => {
    mkdirSync(join(tmpDir, 'sub'))
    writeFileSync(join(tmpDir, 'sub', 'x.ts'), '')
    const r = await executeTool('str_replace_editor', { command: 'view', path: tmpDir }, 'tu_2', { workspaceRoot: tmpDir, ...approveAll })
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(true)
    expect(data.kind).toBe('directory')
    expect((data.entries as string[]).some((e) => e.includes('sub'))).toBe(true)
  })

  it('str_replace 精确替换', async () => {
    const file = join(tmpDir, 'b.ts')
    writeFileSync(file, 'const a = 1\nconst b = 2\n')
    const r = await executeTool(
      'str_replace_editor',
      { command: 'str_replace', path: file, old_str: 'const b = 2', new_str: 'const b = 42' },
      'tu_3',
      { workspaceRoot: tmpDir, ...approveAll },
    )
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(true)
    const content = (await import('node:fs/promises').then((m) => m.readFile(file, 'utf-8')))
    expect(content).toContain('const b = 42')
  })

  it('str_replace 的 new_str 含 $ 不被特殊展开（I2 回归）', async () => {
    const file = join(tmpDir, 'b2.sh')
    writeFileSync(file, 'echo hello\n')
    const r = await executeTool(
      'str_replace_editor',
      {
        command: 'str_replace',
        path: file,
        old_str: 'echo hello',
        new_str: 'echo $1 && echo $&',
      },
      'tu_3b',
      { workspaceRoot: tmpDir, ...approveAll },
    )
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(true)
    const content = await import('node:fs/promises').then((m) => m.readFile(file, 'utf-8'))
    // $1 和 $& 必须原样保留（text.replace 会把 $& 展开为 old_str）
    expect(content).toBe('echo $1 && echo $&\n')
  })

  it('str_replace 多匹配返回 multiple_match', async () => {
    const file = join(tmpDir, 'c.ts')
    writeFileSync(file, 'foo\nfoo\nbar\n')
    const r = await executeTool(
      'str_replace_editor',
      { command: 'str_replace', path: file, old_str: 'foo', new_str: 'baz' },
      'tu_4',
      { workspaceRoot: tmpDir, ...approveAll },
    )
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(false)
    expect(data.error).toBe('multiple_match')
  })

  it('str_replace 无 workspaceRoot 返回 no_workspace', async () => {
    const file = join(tmpDir, 'd.ts')
    writeFileSync(file, 'x\n')
    const r = await executeTool(
      'str_replace_editor',
      { command: 'str_replace', path: file, old_str: 'x', new_str: 'y' },
      'tu_5',
      approveAll,
    )
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(false)
    expect(data.error).toBe('no_workspace')
  })

  it('insert 在指定行后插入', async () => {
    const file = join(tmpDir, 'e.ts')
    writeFileSync(file, 'a\nb\nc\n')
    const r = await executeTool(
      'str_replace_editor',
      { command: 'insert', path: file, insert_line: 1, new_str: 'NEW' },
      'tu_6',
      { workspaceRoot: tmpDir, ...approveAll },
    )
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(true)
    const content = await import('node:fs/promises').then((m) => m.readFile(file, 'utf-8'))
    expect(content).toBe('a\nNEW\nb\nc\n')
  })

  it('工具已注册且 approvalMode=always', () => {
    const defs = listAgentToolDefs()
    const tool = defs.find((t) => t.name === 'str_replace_editor')
    expect(tool).toBeDefined()
  })
})
