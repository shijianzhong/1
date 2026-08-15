import { beforeEach, describe, expect, it, vi } from 'vitest'

const handle = vi.fn()
const listTopics = vi.fn(() => [])
const getTopic = vi.fn(() => null)
const createTopic = vi.fn((input) => ({ id: 'topic_1', userId: 'local', status: 'pending', createdAt: 1, updatedAt: 1, ...input }))
const updateTopic = vi.fn((id, patch) => ({ id, userId: 'local', title: 'ok', status: 'pending', createdAt: 1, updatedAt: 2, ...patch }))
const removeTopic = vi.fn()

vi.mock('electron', () => ({
  ipcMain: { handle },
}))

vi.mock('../logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('../storage/models', () => ({
  listTopics,
  getTopic,
  createTopic,
  updateTopic,
  removeTopic,
}))

describe('ipc/topics', () => {
  beforeEach(() => {
    handle.mockReset()
    listTopics.mockClear()
    getTopic.mockClear()
    createTopic.mockClear()
    updateTopic.mockClear()
    removeTopic.mockClear()
  })

  it('topics:update 只允许可变字段进入 patch', async () => {
    const { registerTopicsHandlers } = await import('./topics')
    registerTopicsHandlers()
    const wrapped = handle.mock.calls.find((call) => call[0] === 'topics:update')?.[1]
    expect(wrapped).toBeTypeOf('function')

    const result = await wrapped({}, { id: 'topic_1', patch: { title: '新标题', status: 'published' } })
    expect(result.ok).toBe(true)
    expect(updateTopic).toHaveBeenCalledWith('topic_1', { title: '新标题', status: 'published' })
  })

  it('topics:update 拒绝 patch 中的 id/userId', async () => {
    const { registerTopicsHandlers } = await import('./topics')
    registerTopicsHandlers()
    const wrapped = handle.mock.calls.find((call) => call[0] === 'topics:update')?.[1]
    expect(wrapped).toBeTypeOf('function')

    const result = await wrapped({}, { id: 'topic_1', patch: { id: 'evil', userId: 'other' } })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('ipc.topics:update')
    expect(updateTopic).not.toHaveBeenCalled()
  })
})
