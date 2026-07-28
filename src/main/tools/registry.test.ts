import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'
import {
  clearTools,
  executeTool,
  registerTool,
} from './registry'

// —— 工具注册表单测（§10.1 + §三之三 J + 铁律11）——

describe('tools/registry', () => {
  beforeEach(() => {
    clearTools()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('注册 + 执行成功，显式 JSON Schema 含 type=object', async () => {
    const schema = z.object({ name: z.string(), count: z.number() })
    const def = registerTool('greet', 'say hi', schema, async (args) => `hello ${(args as { name: string }).name}`)
    expect(def.def.input_schema).toMatchObject({ type: 'object' })
    const result = await executeTool('greet', { name: 'one', count: 1 }, 'tu_1', {})
    expect(result.isError).toBe(false)
    expect(result.content).toBe('hello one')
  })

  it('入参校验失败返回错误 JSON 不抛', async () => {
    const schema = z.object({ name: z.string() })
    registerTool('greet', 'say hi', schema, async (args) => `hi ${(args as { name: string }).name}`)
    const result = await executeTool('greet', { name: 123 }, 'tu_2', {})
    expect(result.isError).toBe(true)
    expect(result.content).toContain('invalid_args')
  })

  it('工具抛异常 → 重试 3 次后返回错误 JSON 不抛（铁律11）', async () => {
    const schema = z.object({})
    const handler = vi.fn().mockRejectedValue(new Error('boom'))
    registerTool('flaky', 'flaky tool', schema, handler)

    const p = executeTool('flaky', {}, 'tu_3', {})
    await vi.advanceTimersToNextTimerAsync()
    await vi.advanceTimersToNextTimerAsync()
    await vi.advanceTimersToNextTimerAsync()
    const result = await p

    expect(handler).toHaveBeenCalledTimes(4) // 初试 + 3 重试
    expect(result.isError).toBe(true)
    expect(result.content).toContain('tool_failed')
  })

  it('未知工具返回错误 JSON 不抛', async () => {
    const result = await executeTool('nope', {}, 'tu_4', {})
    expect(result.isError).toBe(true)
    expect(result.content).toContain('unknown_tool')
  })

  it('工具第二次成功（重试恢复）', async () => {
    const schema = z.object({})
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('recovered')
    registerTool('retry_ok', 'retry ok', schema, handler)

    const p = executeTool('retry_ok', {}, 'tu_5', {})
    await vi.advanceTimersToNextTimerAsync()
    const result = await p

    expect(handler).toHaveBeenCalledTimes(2)
    expect(result.isError).toBe(false)
    expect(result.content).toBe('recovered')
  })
})
