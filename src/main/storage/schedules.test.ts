import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 用临时目录接管 electron 的 userData 路径；getPath 在测试运行期（beforeAll 之后）才被调用。
let storeDir = ''
vi.mock('electron', () => ({ app: { getPath: () => storeDir } }))
vi.mock('../logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

const {
  listSchedules,
  createSchedule,
  getSchedule,
  updateSchedule,
  removeSchedule,
  setScheduleLastFired,
} = await import('./schedules')

beforeAll(() => {
  storeDir = mkdtempSync(join(tmpdir(), 'schedules-test-'))
})

afterAll(() => {
  rmSync(storeDir, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(join(storeDir, 'schedules.json'), { force: true })
})

const basicAction = { type: 'shell' as const, command: 'echo' }

describe('storage/schedules', () => {
  it('create + list 往返，id 前缀 sch_、lastFiredAt 初始 null', () => {
    const s = createSchedule({ name: 'a', cron: '0 9 * * *', action: basicAction })
    expect(s.id).toMatch(/^sch_/)
    expect(s.lastFiredAt).toBeNull()
    const list = listSchedules()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(s.id)
  })

  it('update 局部更新并刷新 updatedAt', () => {
    const s = createSchedule({ name: 'a', cron: '0 9 * * *', action: basicAction })
    const before = s.updatedAt
    const u = updateSchedule(s.id, { enabled: false, name: 'b' })
    expect(u?.enabled).toBe(false)
    expect(u?.name).toBe('b')
    expect(u?.updatedAt).toBeGreaterThanOrEqual(before)
  })

  it('getSchedule 不存在返回 null', () => {
    expect(getSchedule('nope')).toBeNull()
  })

  it('remove 删除成功/失败语义', () => {
    const s = createSchedule({ name: 'a', cron: '0 9 * * *', action: basicAction })
    expect(removeSchedule(s.id)).toBe(true)
    expect(listSchedules()).toHaveLength(0)
    expect(removeSchedule(s.id)).toBe(false)
  })

  it('setScheduleLastFired 写回 lastFiredAt', () => {
    const s = createSchedule({ name: 'a', cron: '0 9 * * *', action: basicAction })
    setScheduleLastFired(s.id, 123)
    expect(getSchedule(s.id)?.lastFiredAt).toBe(123)
  })

  it('原子写：临时 .tmp 已被 rename，无残留', () => {
    createSchedule({ name: 'a', cron: '0 9 * * *', action: basicAction })
    expect(existsSync(join(storeDir, 'schedules.json.tmp'))).toBe(false)
    expect(existsSync(join(storeDir, 'schedules.json'))).toBe(true)
  })
})
