import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { isIpcFailure, type IpcResult } from '@shared/types'

// —— 隔离依赖：storage/scheduler 主进程重模块（含 electron + Agent）全部 mock，
// 仅验证 IPC 边界行为（Zod 校验 / cron 校验 / not_found / runNow 路由）。——
const listSchedules = vi.fn(() => [])
const createSchedule = vi.fn()
const updateSchedule = vi.fn()
const removeSchedule = vi.fn()
const runScheduleNow = vi.fn()

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('../storage/schedules', () => ({ listSchedules, createSchedule, updateSchedule, removeSchedule }))
vi.mock('../scheduler/scheduler', () => ({ runScheduleNow }))
// validateCron 简化：5 段且非空即合法（聚焦 IPC 边界，不重复测 cron 库）
vi.mock('../scheduler/cron', () => ({
  validateCron: (expr: string) => {
    const parts = expr.trim().split(/\s+/)
    return { valid: parts.length === 5 && parts.every(Boolean), error: parts.length === 5 ? undefined : 'segment count' }
  },
}))

type Handler = (event: unknown, input: unknown) => unknown | Promise<unknown>

async function reg(): Promise<void> {
  const { registerSchedulesHandlers } = await import('./schedules')
  registerSchedulesHandlers()
}

function handlerFor(channel: string): Handler {
  const call = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === channel)
  if (!call) throw new Error(`handler not registered: ${channel}`)
  return call[1] as Handler
}

function callWrapped(channel: string, input: unknown): Promise<IpcResult<unknown>> {
  return handlerFor(channel)(undefined, input) as Promise<IpcResult<unknown>>
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ipc/schedules', () => {
  it('create 合法 orchestration → 成功并调用存储', async () => {
    await reg()
    createSchedule.mockReturnValue({ id: 'sch_x' })
    const res = await callWrapped('schedules:create', {
      name: 'a',
      cron: '0 9 * * *',
      action: { type: 'orchestration', prompt: 'do it' },
    })
    expect(isIpcFailure(res)).toBe(false)
    expect(createSchedule).toHaveBeenCalledOnce()
  })

  it('create 非法 cron → 驳回 invalid_cron', async () => {
    await reg()
    const res = await callWrapped('schedules:create', {
      name: 'a',
      cron: '0 9 * *', // 4 段
      action: { type: 'orchestration', prompt: 'do it' },
    })
    expect(isIpcFailure(res)).toBe(true)
    expect((res as { messageKey?: string }).messageKey).toBe('errors:schedules.invalid_cron')
  })

  it('create 非法 action（缺 prompt）→ 驳回 invalid_input', async () => {
    await reg()
    const res = await callWrapped('schedules:create', {
      name: 'a',
      cron: '0 9 * * *',
      action: { type: 'orchestration' }, // 缺 prompt
    })
    expect(isIpcFailure(res)).toBe(true)
    expect((res as { messageKey?: string }).messageKey).toBe('errors:schedules.invalid_input')
  })

  it('update 目标不存在 → 驳回 not_found', async () => {
    await reg()
    updateSchedule.mockReturnValue(null)
    const res = await callWrapped('schedules:update', { id: 'x', name: 'b' })
    expect(isIpcFailure(res)).toBe(true)
    expect((res as { messageKey?: string }).messageKey).toBe('errors:schedules.not_found')
  })

  it('remove 目标不存在 → 驳回 not_found', async () => {
    await reg()
    removeSchedule.mockReturnValue(false)
    const res = await callWrapped('schedules:remove', 'x')
    expect(isIpcFailure(res)).toBe(true)
    expect((res as { messageKey?: string }).messageKey).toBe('errors:schedules.not_found')
  })

  it('toggle 目标不存在 → 驳回 not_found', async () => {
    await reg()
    updateSchedule.mockReturnValue(null)
    const res = await callWrapped('schedules:toggle', { id: 'x', enabled: false })
    expect(isIpcFailure(res)).toBe(true)
    expect((res as { messageKey?: string }).messageKey).toBe('errors:schedules.not_found')
  })

  it('runNow 路由到 runScheduleNow（外层 IpcResult 包裹业务结果）', async () => {
    await reg()
    runScheduleNow.mockReturnValue({ ok: true })
    const res = await callWrapped('schedules:runNow', 'x')
    expect(runScheduleNow).toHaveBeenCalledWith('x')
    expect(isIpcFailure(res)).toBe(false)
    expect((res as IpcResult<{ ok: boolean }>).data).toEqual({ ok: true })
  })
})
