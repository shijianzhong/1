import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { clearTools, executeTool } from '../registry'
import { registerGlobTool } from './glob'

let tmpDir: string

beforeEach(() => {
  clearTools()
  tmpDir = mkdtempSync(join(tmpdir(), 'glob-test-'))
  registerGlobTool()
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

const approveAll = { onApprove: async () => ({ approved: true }) }

describe('glob', () => {
  it('**/*.ts 匹配嵌套 TypeScript 文件', async () => {
    mkdirSync(join(tmpDir, 'src', 'lib'), { recursive: true })
    writeFileSync(join(tmpDir, 'src', 'a.ts'), '')
    writeFileSync(join(tmpDir, 'src', 'lib', 'b.ts'), '')
    writeFileSync(join(tmpDir, 'src', 'c.js'), '')
    const r = await executeTool('glob', { pattern: '**/*.ts' }, 'gl1', { workspaceRoot: tmpDir, ...approveAll })
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(true)
    expect(data.files.length).toBe(2)
    expect(data.files.every((f: string) => f.endsWith('.ts'))).toBe(true)
  })

  it('src/**/*.ts 匹配 src 下嵌套', async () => {
    mkdirSync(join(tmpDir, 'src', 'lib'), { recursive: true })
    mkdirSync(join(tmpDir, 'other'))
    writeFileSync(join(tmpDir, 'src', 'a.ts'), '')
    writeFileSync(join(tmpDir, 'src', 'lib', 'b.ts'), '')
    writeFileSync(join(tmpDir, 'other', 'c.ts'), '')
    const r = await executeTool('glob', { pattern: 'src/**/*.ts' }, 'gl2', { workspaceRoot: tmpDir, ...approveAll })
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(true)
    expect(data.files.length).toBe(2)
  })

  it('path 限定子目录', async () => {
    mkdirSync(join(tmpDir, 'sub'))
    writeFileSync(join(tmpDir, 'sub', 'x.ts'), '')
    writeFileSync(join(tmpDir, 'root.ts'), '')
    const r = await executeTool(
      'glob',
      { pattern: '**/*.ts', path: 'sub' },
      'gl3',
      { workspaceRoot: tmpDir, ...approveAll },
    )
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(true)
    expect(data.files.length).toBe(1)
    expect(data.files[0]).toContain('sub')
  })

  it('无 workspaceRoot 返回 no_workspace', async () => {
    const r = await executeTool('glob', { pattern: '**/*.ts' }, 'gl4', approveAll)
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(false)
    expect(data.error).toBe('no_workspace')
  })
})
