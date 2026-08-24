import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { L1Summary, L2Digest, L3Fact } from '@shared/types'

// —— memory IPC handlers 单测（§三之三 D + 铁律21）——
// 复用 topics.test.ts 模式：mock electron(ipcMain) + logger + 三层存储模块，
// 断言 channel 路由、参数透传（user='local'）、Zod 校验失败转 i18n messageKey。

const handle = vi.fn()
const listL1 = vi.fn<() => L1Summary[]>(() => [])
const removeL1 = vi.fn()
const listL2 = vi.fn<() => L2Digest[]>(() => [])
const updateL2Digest = vi.fn()
const removeL2Entry = vi.fn()
const listL3 = vi.fn<() => L3Fact[]>(() => [])
const saveL3 = vi.fn()
const removeL3 = vi.fn()

vi.mock('electron', () => ({
  ipcMain: { handle },
}))

vi.mock('../logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('../storage/memory/l1', () => ({ listL1, removeL1 }))
vi.mock('../storage/memory/l2', () => ({ listL2, updateL2Digest, removeL2Entry }))
vi.mock('../storage/memory/l3', () => ({ listL3, saveL3, removeL3 }))

function channelHandler(name: string): (...args: unknown[]) => Promise<unknown> {
  const wrapped = handle.mock.calls.find((c) => c[0] === name)?.[1]
  if (typeof wrapped !== 'function') throw new Error(`handler not registered: ${name}`)
  return wrapped as (...args: unknown[]) => Promise<unknown>
}

describe('ipc/memory', () => {
  beforeEach(() => {
    handle.mockReset()
    listL1.mockClear()
    removeL1.mockClear()
    listL2.mockClear()
    updateL2Digest.mockClear()
    removeL2Entry.mockClear()
    listL3.mockClear()
    saveL3.mockClear()
    removeL3.mockClear()
  })

  it('registerMemoryHandlers 注册全部 7 个 channel', async () => {
    const { registerMemoryHandlers } = await import('./memory')
    registerMemoryHandlers()
    const names = handle.mock.calls.map((c) => c[0])
    expect(names).toEqual(
      expect.arrayContaining([
        'memory:list',
        'memory:l3:add',
        'memory:l3:update',
        'memory:l3:remove',
        'memory:l2:update',
        'memory:l2:remove',
        'memory:l1:remove',
      ]),
    )
  })

  it('memory:list 聚合三层并按 user=local 透传', async () => {
    listL1.mockReturnValue([{ sessionId: 's1', summary: 'a', ts: 1 }])
    listL2.mockReturnValue([{ userId: 'local', sessionId: 's1', digest: 'd', ts: 1 }])
    listL3.mockReturnValue([{ userId: 'local', key: 'k', value: 'v', ts: 1 }])
    const { registerMemoryHandlers } = await import('./memory')
    registerMemoryHandlers()
    const res = (await channelHandler('memory:list')({})) as {
      ok: boolean
      data: { l1: unknown[]; l2: unknown[]; l3: unknown[] }
    }
    expect(res.ok).toBe(true)
    expect(res.data.l1).toHaveLength(1)
    expect(res.data.l2).toHaveLength(1)
    expect(res.data.l3).toHaveLength(1)
    expect(listL1).toHaveBeenCalled()
    expect(listL2).toHaveBeenCalledWith('local')
    expect(listL3).toHaveBeenCalledWith('local')
  })

  it('memory:l3:add 合法 → saveL3(local, key, value)', async () => {
    const { registerMemoryHandlers } = await import('./memory')
    registerMemoryHandlers()
    const res = (await channelHandler('memory:l3:add')({}, { key: 'preference:run', value: 'v' })) as {
      ok: boolean
    }
    expect(res.ok).toBe(true)
    expect(saveL3).toHaveBeenCalledWith('local', 'preference:run', 'v')
  })

  it('memory:l3:add 空 key → 结构化错误（messageKey=errors:memory.invalid_input）', async () => {
    const { registerMemoryHandlers } = await import('./memory')
    registerMemoryHandlers()
    const res = (await channelHandler('memory:l3:add')({}, { key: '', value: 'v' })) as {
      ok: boolean
      code: string
      messageKey?: string
    }
    expect(res.ok).toBe(false)
    expect(res.messageKey).toBe('errors:memory.invalid_input')
    expect(saveL3).not.toHaveBeenCalled()
  })

  it('memory:l3:remove 合法 → removeL3(local, key)', async () => {
    const { registerMemoryHandlers } = await import('./memory')
    registerMemoryHandlers()
    const res = (await channelHandler('memory:l3:remove')({}, { key: 'k' })) as { ok: boolean }
    expect(res.ok).toBe(true)
    expect(removeL3).toHaveBeenCalledWith('local', 'k')
  })

  it('memory:l2:update 合法 → updateL2Digest(local, sessionId, ts, digest)', async () => {
    const { registerMemoryHandlers } = await import('./memory')
    registerMemoryHandlers()
    const res = (await channelHandler('memory:l2:update')({}, {
      sessionId: 's1',
      ts: 100,
      digest: 'edited',
    })) as { ok: boolean }
    expect(res.ok).toBe(true)
    expect(updateL2Digest).toHaveBeenCalledWith('local', 's1', 100, 'edited')
  })

  it('memory:l2:update 缺 digest → 结构化错误', async () => {
    const { registerMemoryHandlers } = await import('./memory')
    registerMemoryHandlers()
    const res = (await channelHandler('memory:l2:update')({}, { sessionId: 's1', ts: 100 })) as {
      ok: boolean
      messageKey?: string
    }
    expect(res.ok).toBe(false)
    expect(res.messageKey).toBe('errors:memory.invalid_input')
  })

  it('memory:l2:remove 合法 → removeL2Entry(local, sessionId, ts)', async () => {
    const { registerMemoryHandlers } = await import('./memory')
    registerMemoryHandlers()
    const res = (await channelHandler('memory:l2:remove')({}, { sessionId: 's1', ts: 100 })) as {
      ok: boolean
    }
    expect(res.ok).toBe(true)
    expect(removeL2Entry).toHaveBeenCalledWith('local', 's1', 100)
  })

  it('memory:l1:remove 合法 → removeL1(sessionId)', async () => {
    const { registerMemoryHandlers } = await import('./memory')
    registerMemoryHandlers()
    const res = (await channelHandler('memory:l1:remove')({}, { sessionId: 's1' })) as {
      ok: boolean
    }
    expect(res.ok).toBe(true)
    expect(removeL1).toHaveBeenCalledWith('s1')
  })
})
