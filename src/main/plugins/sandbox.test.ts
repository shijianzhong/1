import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// mock registry 的两个运行时导入（executeTool 白名单内动作时被调；newToolUseId 生成 id）
// 类型导入（ToolContext/ToolResult）被擦除，不受 mock 影响
vi.mock('../tools/registry', () => ({
  executeTool: vi.fn(),
  newToolUseId: vi.fn(() => 'tu-mock'),
}))

import { compileBHandler, runBHandler } from './sandbox'
import { executeTool } from '../tools/registry'
import type { ToolContext } from '../tools/registry'

const bCtx = { toolUseId: 'tu1' } as ToolContext

describe('compileBHandler（vm 编译期）', () => {
  it('合法源码 → 返回 factory 函数', () => {
    const factory = compileBHandler("return 'hello'", 'good1')
    expect(typeof factory).toBe('function')
  })

  it('语法错误 → 抛 SyntaxError', () => {
    expect(() => compileBHandler('const x = ;', 'bad1')).toThrow()
  })
})

describe('runBHandler（执行围栏）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('正常返回字符串 → content 透传', async () => {
    const factory = compileBHandler("return 'hello'", 'good2')
    const r = await runBHandler(factory, {}, bCtx)
    expect(r.isError).toBe(false)
    expect(r.content).toBe('hello')
    expect(r.toolUseId).toBe('tu1')
  })

  it('正常返回对象 → JSON 序列化', async () => {
    const factory = compileBHandler('return { a: 1, b: "x" }', 'good3')
    const r = await runBHandler(factory, {}, bCtx)
    expect(r.content).toBe(JSON.stringify({ a: 1, b: 'x' }))
  })

  it('白名单外动作 → 返回 action_not_whitelisted 且不调 executeTool', async () => {
    // handler 直接 return 该结果，便于检查封禁输出；外层 isError 反映 handler 是否抛错（不继承内层）
    const factory = compileBHandler(
      'return await ctx.executeTool("shell", { cmd: "rm -rf /" })',
      'bad2',
    )
    const r = await runBHandler(factory, {}, bCtx)
    expect(r.isError).toBe(false)
    expect(r.content).toContain('action_not_whitelisted')
    expect(executeTool).not.toHaveBeenCalled()
  })

  it('白名单内动作 → 透传 executeTool 结果', async () => {
    vi.mocked(executeTool).mockResolvedValue({
      toolUseId: 'tu-mock',
      content: 'filedata',
      isError: false,
    })
    const factory = compileBHandler(
      'const r = await ctx.executeTool("file_read", { path: "/x" }); return r.content',
      'good4',
    )
    const r = await runBHandler(factory, {}, bCtx)
    expect(r.content).toBe('filedata')
    expect(executeTool).toHaveBeenCalledTimes(1)
    const [action, args, toolUseId] = vi.mocked(executeTool).mock.calls[0]
    expect(action).toBe('file_read')
    expect(args).toEqual({ path: '/x' })
    expect(toolUseId).toBe('tu-mock')
  })

  it('超时（永不 resolve）→ 返回 timeout 错误', async () => {
    vi.useFakeTimers()
    try {
      const factory = compileBHandler('await new Promise(() => {})', 'slow1')
      const p = runBHandler(factory, {}, bCtx)
      // 60s 围栏触发 AbortController.abort → Promise.race reject → runBHandler 返回 timeout
      await vi.advanceTimersByTimeAsync(60_001)
      const r = await p
      expect(r.isError).toBe(true)
      expect(r.content).toContain('timeout')
    } finally {
      vi.useRealTimers()
    }
  })

  it('输出超 16KB → 截断 + 标记', async () => {
    const factory = compileBHandler("return 'x'.repeat(20000)", 'big1')
    const r = await runBHandler(factory, {}, bCtx)
    expect(r.isError).toBe(false)
    expect(r.content.endsWith('[output truncated]')).toBe(true)
    // 16KB + 标记串长度
    expect(r.content.length).toBe(16_000 + '\n[output truncated]'.length)
  })

  it('handler 抛错 → 返回 isError + 错误信息', async () => {
    const factory = compileBHandler('throw new Error("boom")', 'err1')
    const r = await runBHandler(factory, {}, bCtx)
    expect(r.isError).toBe(true)
    expect(r.content).toContain('boom')
  })

  it('handler 返回 undefined → content 为空串（不崩溃）', async () => {
    const factory = compileBHandler('return undefined', 'undef1')
    const r = await runBHandler(factory, {}, bCtx)
    expect(r.isError).toBe(false)
    expect(r.content).toBe('')
  })
})

afterEach(() => {
  vi.useRealTimers()
})
