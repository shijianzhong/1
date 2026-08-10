import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { clearTools, executeTool } from '../registry'
import { registerGrepTool } from './grep'

let tmpDir: string

beforeEach(() => {
  clearTools()
  tmpDir = mkdtempSync(join(tmpdir(), 'grep-test-'))
  registerGrepTool()
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

const approveAll = { onApprove: async () => ({ approved: true }) }

describe('grep', () => {
  it('content 模式返回匹配行', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'function foo() {}\nconst bar = 1\n')
    writeFileSync(join(tmpDir, 'b.ts'), 'foo is here\n')
    const r = await executeTool('grep', { pattern: 'foo' }, 'g1', { workspaceRoot: tmpDir, ...approveAll })
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(true)
    expect(data.matches.length).toBeGreaterThanOrEqual(2)
    expect(data.matches[0].content).toContain('foo')
  })

  it('glob 过滤文件（I1 回归：非空且只含 .ts）', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'target\n')
    writeFileSync(join(tmpDir, 'a.js'), 'target\n')
    const r = await executeTool(
      'grep',
      { pattern: 'target', glob: '*.ts' },
      'g2',
      { workspaceRoot: tmpDir, ...approveAll },
    )
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(true)
    // I1 修复后真断言：结果非空（空数组 .every() 空真通过是假阳性）
    expect(data.matches.length).toBeGreaterThan(0)
    expect(data.matches.every((m: { path: string }) => m.path.endsWith('.ts'))).toBe(true)
  })

  it('files_with_matches 只返回文件路径', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'foo\n')
    const r = await executeTool(
      'grep',
      { pattern: 'foo', output_mode: 'files_with_matches' },
      'g3',
      { workspaceRoot: tmpDir, ...approveAll },
    )
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(true)
    expect(data.files).toContain(join(tmpDir, 'a.ts'))
  })

  it('files_with_matches + glob 过滤（I1 回归：非空且只含 .ts）', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'target\n')
    writeFileSync(join(tmpDir, 'b.js'), 'target\n')
    const r = await executeTool(
      'grep',
      { pattern: 'target', output_mode: 'files_with_matches', glob: '*.ts' },
      'g3b',
      { workspaceRoot: tmpDir, ...approveAll },
    )
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(true)
    expect(data.files.length).toBeGreaterThan(0)
    expect(data.files.every((f: string) => f.endsWith('.ts'))).toBe(true)
  })

  it('count 模式返回统计', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'foo\nfoo\n')
    const r = await executeTool(
      'grep',
      { pattern: 'foo', output_mode: 'count' },
      'g4',
      { workspaceRoot: tmpDir, ...approveAll },
    )
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(true)
    expect(data.totalMatches).toBe(2)
    expect(data.filesWithMatches).toBe(1)
  })

  it('无 workspaceRoot 返回 no_workspace', async () => {
    const r = await executeTool('grep', { pattern: 'x' }, 'g5', approveAll)
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(false)
    expect(data.error).toBe('no_workspace')
  })
})
