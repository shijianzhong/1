import { describe, expect, it, beforeEach, vi } from 'vitest'
import { clearTools, executeTool, listToolDefs } from '../registry'
import { registerScheduleCreateTool } from './scheduleCreate'

// —— schedule_create 工具单测 ——
// mock createSchedule（不碰真实文件系统）+ cron 校验用真实 @shared/cron 纯函数。
// 分支：cron 非法 / cron 永不命中 / 未注入 onAskUser / 用户拒绝 / 用户确认（多肯定词）。

vi.mock('../../storage/schedules', () => ({
  createSchedule: vi.fn(),
}))
import { createSchedule } from '../../storage/schedules'

const createMock = createSchedule as unknown as ReturnType<typeof vi.fn>

const VALID_ACTION = { type: 'orchestration' as const, prompt: '测试提示词' }

describe('tools/builtin/scheduleCreate', () => {
  beforeEach(() => {
    clearTools()
    registerScheduleCreateTool()
    createMock.mockReset()
    createMock.mockImplementation((input: { name: string }) => ({
      id: 'sch_test1',
      name: input.name,
      createdAt: 1234567890000,
    }))
  })

  it('已注册进工具清单（主 agent 可见）', () => {
    const def = listToolDefs().find((d) => d.name === 'schedule_create')
    expect(def).toBeDefined()
    // inputSchemaOverride 手写 oneOf 应生效（不是 zodToJsonSchema 的空 {}）
    const schema = def!.input_schema as Record<string, unknown>
    expect(schema.type).toBe('object')
    expect((schema.properties as Record<string, unknown>).action).toHaveProperty('oneOf')
  })

  it('cron 非法：返回 invalid_cron，未调 onAskUser / 未落库', async () => {
    const onAskUser = vi.fn()
    const result = await executeTool(
      'schedule_create',
      { name: 't', cron: 'bad', action: VALID_ACTION },
      'tu_1',
      { onAskUser },
    )
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.content) as { ok: boolean; error: string }
    expect(parsed).toMatchObject({ ok: false, error: 'invalid_cron' })
    expect(onAskUser).not.toHaveBeenCalled()
    expect(createMock).not.toHaveBeenCalled()
  })

  it('cron 5 段非法（4 段）：返回 invalid_cron', async () => {
    const result = await executeTool(
      'schedule_create',
      { name: 't', cron: '0 9 * *', action: VALID_ACTION },
      'tu_2',
      { onAskUser: vi.fn() },
    )
    const parsed = JSON.parse(result.content) as { ok: boolean; error: string }
    expect(parsed).toMatchObject({ ok: false, error: 'invalid_cron' })
  })

  it('cron 语法合法但永不命中（2 月 30 日）：返回 invalid_cron，未调 onAskUser', async () => {
    const onAskUser = vi.fn()
    const result = await executeTool(
      'schedule_create',
      { name: 't', cron: '0 9 30 2 *', action: VALID_ACTION },
      'tu_3',
      { onAskUser },
    )
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.content) as { ok: boolean; error: string }
    expect(parsed).toMatchObject({ ok: false, error: 'invalid_cron' })
    expect(onAskUser).not.toHaveBeenCalled()
  })

  it('非法 IANA 时区（Asia/Shangai 拼错）：返回 invalid_timezone，未调 onAskUser/未落库', async () => {
    const onAskUser = vi.fn()
    const result = await executeTool(
      'schedule_create',
      { name: 't', cron: '0 9 * * *', timezone: 'Asia/Shangai', action: VALID_ACTION },
      'tu_tz',
      { onAskUser },
    )
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.content) as { ok: boolean; error: string }
    expect(parsed).toMatchObject({ ok: false, error: 'invalid_timezone' })
    expect(onAskUser).not.toHaveBeenCalled()
    expect(createMock).not.toHaveBeenCalled()
  })

  it('未注入 onAskUser：返回 user_input_unavailable，未落库', async () => {
    const result = await executeTool(
      'schedule_create',
      { name: 't', cron: '0 9 * * *', action: VALID_ACTION },
      'tu_4',
      {},
    )
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.content) as { ok: boolean; error: string }
    expect(parsed).toMatchObject({ ok: false, error: 'user_input_unavailable' })
    expect(createMock).not.toHaveBeenCalled()
  })

  it('用户拒绝：返回 user_declined，未落库', async () => {
    const onAskUser = vi.fn(async () => '不要了')
    const result = await executeTool(
      'schedule_create',
      { name: 't', cron: '0 9 * * *', action: VALID_ACTION },
      'tu_5',
      { onAskUser },
    )
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.content) as { ok: boolean; error: string }
    expect(parsed).toMatchObject({ ok: false, error: 'user_declined' })
    expect(createMock).not.toHaveBeenCalled()
  })

  it('onAskUser 抛错：转 user_input_unavailable 不抛', async () => {
    const onAskUser = vi.fn(async () => {
      throw new Error('user_input_timeout')
    })
    const result = await executeTool(
      'schedule_create',
      { name: 't', cron: '0 9 * * *', action: VALID_ACTION },
      'tu_6',
      { onAskUser },
    )
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.content) as { ok: boolean; error: string }
    expect(parsed).toMatchObject({ ok: false, error: 'user_input_unavailable' })
    expect(createMock).not.toHaveBeenCalled()
  })

  it.each([
    ['确认', 'tu_a'],
    ['好的', 'tu_b'],
    ['yes', 'tu_c'],
    ['OK', 'tu_d'],
    ['可以', 'tu_e'],
    ['是', 'tu_f'],
  ])('用户答「%s」：落库 + 返回 ok:true scheduleId/nextRun', async (_word, tuId) => {
    const onAskUser = vi.fn(async () => _word)
    const result = await executeTool(
      'schedule_create',
      { name: '测试任务', cron: '0 9 * * *', action: VALID_ACTION },
      tuId,
      { onAskUser },
    )
    expect(result.isError).toBe(false)
    const parsed = JSON.parse(result.content) as {
      ok: boolean
      scheduleId: string
      nextRun: string | null
      nextRunIso: string | null
    }
    expect(parsed).toMatchObject({ ok: true, scheduleId: 'sch_test1' })
    expect(parsed.nextRun).not.toBeNull() // 本地可读串
    // nextRunIso 为 ISO 8601（以 Z 结尾），与 nextRun（本地非 ISO）区分
    expect(parsed.nextRunIso).not.toBeNull()
    expect(parsed.nextRunIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
    // 落库参数透传
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: '测试任务', cron: '0 9 * * *', action: VALID_ACTION }),
    )
  })

  it.each([['不要', 'tu_g'], ['算了', 'tu_h'], ['no', 'tu_i'], ['别', 'tu_j']])(
    '用户答「%s」：拒绝，未落库',
    async (_word, tuId) => {
      const onAskUser = vi.fn(async () => _word)
      const result = await executeTool(
        'schedule_create',
        { name: 't', cron: '0 9 * * *', action: VALID_ACTION },
        tuId,
        { onAskUser },
      )
      const parsed = JSON.parse(result.content) as { ok: boolean; error: string }
      expect(parsed).toMatchObject({ ok: false, error: 'user_declined' })
      expect(createMock).not.toHaveBeenCalled()
    },
  )

  it('shell action 确认后落库：透传 command/args/cwd/timeoutMs', async () => {
    const onAskUser = vi.fn(async () => '确认')
    const shellAction = {
      type: 'shell' as const,
      command: '/usr/bin/echo',
      args: ['hello'],
      cwd: '/tmp',
      timeoutMs: 5000,
    }
    await executeTool(
      'schedule_create',
      { name: 'shell 任务', cron: '*/5 * * * *', action: shellAction },
      'tu_k',
      { onAskUser },
    )
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: shellAction, cron: '*/5 * * * *' }),
    )
  })

  it('timezone 透传：onAskUser 文案含时区', async () => {
    const seen: Array<{ question: string }> = []
    const onAskUser = vi.fn(async (req) => {
      seen.push(req)
      return '确认'
    })
    await executeTool(
      'schedule_create',
      { name: 't', cron: '0 9 * * *', action: VALID_ACTION, timezone: 'Asia/Shanghai' },
      'tu_l',
      { onAskUser },
    )
    expect(onAskUser).toHaveBeenCalled()
    expect(seen[0].question).toContain('Asia/Shanghai')
  })
})
