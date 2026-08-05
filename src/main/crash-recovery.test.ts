import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// —— 哨兵路径必须不依赖 drafts/ 是否存在（用户实撞：drafts 未建 → 每次启动写失败）——

let tmpRoot: string

vi.mock('./storage/paths', () => ({
  getUserDataDir: () => tmpRoot,
  getDraftsDir: () => join(tmpRoot, 'drafts'),
}))

vi.mock('./logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

// 动态 import：mock 生效后再加载被测模块
const load = async () => import('./crash-recovery')

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'one-crash-'))
  vi.resetModules()
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('crash-recovery sentinel', () => {
  it('drafts 目录不存在时 markRunning 仍能写哨兵', async () => {
    const { markRunning, hadCrashedLastRun, clearRunning } = await load()
    expect(existsSync(join(tmpRoot, 'drafts'))).toBe(false)

    markRunning()

    expect(existsSync(join(tmpRoot, '.running'))).toBe(true)
    expect(hadCrashedLastRun()).toBe(true)

    clearRunning()
    expect(existsSync(join(tmpRoot, '.running'))).toBe(false)
    expect(hadCrashedLastRun()).toBe(false)
  })

  it('异常退出后再次启动能检测到崩溃（先检测再 mark）', async () => {
    const mod = await load()
    mod.markRunning()
    // 模拟崩溃：不调 clearRunning
    // —— 下一轮启动（同进程重载模块，复用 tmpRoot）——
    vi.resetModules()
    const next = await load()
    expect(next.hadCrashedLastRun()).toBe(true)
    next.markRunning() // 真实 index.ts：先 hadCrashedLastRun 再 markRunning
    next.clearRunning()
    expect(next.hadCrashedLastRun()).toBe(false)
  })

  it('removeDraft 拒绝路径穿越', async () => {
    const { removeDraft, listDrafts } = await load()
    const drafts = join(tmpRoot, 'drafts')
    mkdirSync(drafts, { recursive: true })
    writeFileSync(join(drafts, 'ok.json'), '{"a":1}', 'utf8')
    // 尝试删到 userData 外
    const outside = join(tmpRoot, 'secret.txt')
    writeFileSync(outside, 'nope', 'utf8')
    removeDraft('../secret.txt')
    expect(existsSync(outside)).toBe(true)
    expect(listDrafts().map((d) => d.name)).toEqual(['ok.json'])
    removeDraft('ok.json')
    expect(listDrafts()).toEqual([])
  })
})
