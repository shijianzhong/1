import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { clearTools, executeTool, listToolDefs } from '../registry'
import { registerFileTools } from './file'

// —— file_* 工具单测：路径围栏 / 原子写 / 追加 / 搜索 ——
// getUserDataDir mock 到临时目录；额外根经 config/file-roots.json 注入临时 vault。

vi.mock('../../storage/paths', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const p = await import('node:path')
  const root = mkdtempSync(p.join(tmpdir(), 'one-file-test-'))
  ;(globalThis as Record<string, unknown>).__oneFileTestRoot = root
  return { getUserDataDir: () => root }
})

const tmpRoot = (): string => (globalThis as Record<string, unknown>).__oneFileTestRoot as string
const vault = (): string => path.join(tmpRoot(), 'vault')

describe('tools/builtin/file', () => {
  beforeEach(() => {
    clearTools()
    registerFileTools()
    // 根列表整体覆盖为临时 vault（隔离真实 ~/sh/DailyNotes）
    process.env.ONE_FILE_ROOTS = JSON.stringify([vault()])
    mkdirSync(vault(), { recursive: true })
  })

  afterEach(() => {
    delete process.env.ONE_FILE_ROOTS
  })

  it('三个工具注册进清单', () => {
    const names = listToolDefs().map((t) => t.name)
    expect(names).toContain('file_write')
    expect(names).toContain('file_read')
    expect(names).toContain('file_search')
  })

  it('file_write 自动建目录写入，file_read 回读', async () => {
    const target = path.join(vault(), '2026-08-01', '2026-08-01-公众号-ai-coding.md')
    const w = await executeTool('file_write', { path: target, content: '# 标题\n正文' }, 'tu_1', {})
    const wd = JSON.parse(w.content)
    expect(wd.ok).toBe(true)
    expect(existsSync(target)).toBe(true)

    const r = await executeTool('file_read', { path: target }, 'tu_2', {})
    const rd = JSON.parse(r.content)
    expect(rd.ok).toBe(true)
    expect(rd.content).toBe('# 标题\n正文')
  })

  it('file_write append 模式追加内容', async () => {
    const target = path.join(vault(), 'note.md')
    await executeTool('file_write', { path: target, content: '第一段' }, 'tu_3', {})
    await executeTool('file_write', { path: target, content: '\n第二段', mode: 'append' }, 'tu_4', {})
    expect(readFileSync(target, 'utf8')).toBe('第一段\n第二段')
  })

  it('围栏外路径拒绝（/etc）', async () => {
    const r = await executeTool('file_write', { path: '/etc/one-evil.md', content: 'x' }, 'tu_5', {})
    const d = JSON.parse(r.content)
    expect(d.ok).toBe(false)
    expect(d.error).toBe('path_not_allowed')
    expect(existsSync('/etc/one-evil.md')).toBe(false)
  })

  it('../ 逃逸拒绝（vault 外相邻路径）', async () => {
    const r = await executeTool(
      'file_write',
      { path: path.join(vault(), '..', 'escape.md'), content: 'x' },
      'tu_6',
      {},
    )
    const d = JSON.parse(r.content)
    expect(d.ok).toBe(false)
    expect(d.error).toBe('path_not_allowed')
  })

  it('file_read 不存在 → not_found 结构化错误', async () => {
    const r = await executeTool('file_read', { path: path.join(vault(), 'nope.md') }, 'tu_7', {})
    const d = JSON.parse(r.content)
    expect(d.ok).toBe(false)
    expect(d.error).toBe('not_found')
  })

  it('file_search 按文件名与内容命中，返回匹配行', async () => {
    // 独立搜索根，隔离前面用例写入的文件
    const searchRoot = path.join(tmpRoot(), 'search-vault')
    process.env.ONE_FILE_ROOTS = JSON.stringify([searchRoot])
    mkdirSync(path.join(searchRoot, 'sub'), { recursive: true })
    writeFileSync(path.join(searchRoot, 'AI 编程提效.md'), '# AI 编程\n谈到 Cursor 与提效\n')
    writeFileSync(path.join(searchRoot, 'sub', '周报.md'), '# 周报\n本周试了 AI 编程工具\n')
    writeFileSync(path.join(searchRoot, '无关.md'), '# 菜谱\n红烧肉做法\n')

    const r = await executeTool('file_search', { query: 'AI 编程' }, 'tu_8', {})
    const d = JSON.parse(r.content)
    expect(d.ok).toBe(true)
    expect(d.count).toBe(2)
    const titles = d.files.map((f: { title: string }) => f.title)
    expect(titles).toContain('AI 编程提效')
    expect(titles).toContain('周报') // 内容命中（递归子目录）
    expect(titles).not.toContain('无关')
  })
})
