import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'
import {
  clearTools,
  executeTool,
  registerTool,
  unregisterByPrefix,
  hasTool,
  listToolDefs,
  listBuiltinToolDefs,
  listAgentToolDefs,
  mcpServerIdFromToolName,
} from './registry'
import {
  clearAllSessionToolApprovals,
  grantSessionToolApproval,
} from './sessionApprovals'

// —— 工具注册表单测（§10.1 + §三之三 J + 铁律11）——

describe('tools/registry', () => {
  beforeEach(() => {
    clearTools()
    clearAllSessionToolApprovals()
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

  it('z.enum 转 JSON Schema 带 enum 可选值（propose_persona preferredLanguage 依赖）', () => {
    const schema = z.object({ lang: z.enum(['zh-CN', 'en']).optional() })
    const def = registerTool('enum_tool', 'enum test', schema, async () => 'ok')
    expect(def.def.input_schema).toMatchObject({
      type: 'object',
      properties: { lang: { type: 'string', enum: ['zh-CN', 'en'] } },
    })
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

  // —— approval 闸门 + preCheck 硬拦截 + inputSchemaOverride ——

  it('preCheck 硬拦截：返回 ok=false 则直接拒绝，不进入审批', async () => {
    const schema = z.object({ cmd: z.string() })
    const handler = vi.fn().mockResolvedValue('should_not_reach')
    registerTool('dangerous', 'needs precheck', schema, handler, 'always', {
      preCheck: (args) => {
        const { cmd } = args as { cmd: string }
        if (cmd.includes('rm -rf')) {
          return { ok: false, error: 'danger_command', messageKey: 'errors.tools.shell_danger_command' }
        }
        return { ok: true }
      },
    })

    const result = await executeTool('dangerous', { cmd: 'rm -rf /' }, 'tu_6', {
      onApprove: vi.fn().mockResolvedValue({ approved: true }),
    })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('danger_command')
    expect(result.content).toContain('errors.tools.shell_danger_command')
    expect(handler).not.toHaveBeenCalled()
  })

  it('preCheck 通过 + approvalMode=always + 无 onApprove → approval_unavailable', async () => {
    const schema = z.object({ cmd: z.string() })
    registerTool('needs_approval', 'needs approval', schema, vi.fn().mockResolvedValue('ok'), 'always')

    const result = await executeTool('needs_approval', { cmd: 'ls' }, 'tu_7', {})

    expect(result.isError).toBe(true)
    expect(result.content).toContain('approval_unavailable')
  })

  it('approvalMode=always + onApprove approved → 正常执行', async () => {
    const schema = z.object({ cmd: z.string() })
    const handler = vi.fn().mockResolvedValue('done')
    registerTool('approved_tool', 'needs approval', schema, handler, 'always')

    const onApprove = vi.fn().mockResolvedValue({ approved: true })
    const result = await executeTool('approved_tool', { cmd: 'echo hi' }, 'tu_8', { onApprove })

    expect(result.isError).toBe(false)
    expect(result.content).toBe('done')
    expect(onApprove).toHaveBeenCalledWith({ toolName: 'approved_tool', args: { cmd: 'echo hi' } })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('approvalMode=always + onApprove denied → approval_denied', async () => {
    const schema = z.object({ cmd: z.string() })
    const handler = vi.fn().mockResolvedValue('should_not_reach')
    registerTool('denied_tool', 'needs approval', schema, handler, 'always')

    const onApprove = vi.fn().mockResolvedValue({ approved: false, reason: 'user said no' })
    const result = await executeTool('denied_tool', { cmd: 'echo hi' }, 'tu_9', { onApprove })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('approval_denied')
    expect(handler).not.toHaveBeenCalled()
  })

  it('approvalMode=always + 300s 超时 → approval_timeout', async () => {
    const schema = z.object({ cmd: z.string() })
    const handler = vi.fn().mockResolvedValue('should_not_reach')
    registerTool('timeout_tool', 'needs approval', schema, handler, 'always')

    // onApprove 永不 resolve，withTimeout 300s 后返回 null
    const onApprove = vi.fn().mockReturnValue(new Promise(() => {}))
    const p = executeTool('timeout_tool', { cmd: 'echo hi' }, 'tu_10', { onApprove })

    // 推进 300s → withTimeout 的 setTimeout 触发 → resolve(null)
    await vi.advanceTimersByTimeAsync(300_000)
    const result = await p

    expect(result.isError).toBe(true)
    expect(result.content).toContain('approval_timeout')
    expect(handler).not.toHaveBeenCalled()
  })

  it('approvalMode=auto → 无需审批直接执行', async () => {
    const schema = z.object({ cmd: z.string() })
    const handler = vi.fn().mockResolvedValue('auto_ok')
    registerTool('auto_tool', 'auto mode', schema, handler, 'auto')

    const onApprove = vi.fn()
    const result = await executeTool('auto_tool', { cmd: 'ls' }, 'tu_11', { onApprove })

    expect(result.isError).toBe(false)
    expect(result.content).toBe('auto_ok')
    expect(onApprove).not.toHaveBeenCalled()
  })

  it('本会话已放行 always 工具 → 跳过 onApprove 直接执行', async () => {
    const schema = z.object({ cmd: z.string() })
    const handler = vi.fn().mockResolvedValue('session_ok')
    registerTool('session_shell', 'needs approval', schema, handler, 'always')
    grantSessionToolApproval('sess_chat', 'session_shell')

    const onApprove = vi.fn()
    const result = await executeTool(
      'session_shell',
      { cmd: 'ls' },
      'tu_sess',
      { sessionId: 'sess_chat', onApprove },
    )

    expect(result.isError).toBe(false)
    expect(result.content).toBe('session_ok')
    expect(onApprove).not.toHaveBeenCalled()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('本会话放行不绕过 preCheck 硬拦', async () => {
    const schema = z.object({ cmd: z.string() })
    const handler = vi.fn().mockResolvedValue('nope')
    registerTool('session_danger', 'needs approval', schema, handler, 'always', {
      preCheck: () => ({ ok: false, error: 'danger_command' }),
    })
    grantSessionToolApproval('sess_chat', 'session_danger')

    const result = await executeTool(
      'session_danger',
      { cmd: 'rm -rf /' },
      'tu_sess_d',
      { sessionId: 'sess_chat', onApprove: vi.fn() },
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('danger_command')
    expect(handler).not.toHaveBeenCalled()
  })

  it('inputSchemaOverride 覆盖 zodToJsonSchema（MCP 工具场景）', () => {
    const schema = z.object({ cmd: z.string() })
    const override = {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'overridden description' },
        extra: { type: 'number', description: 'not in zod but visible to LLM' },
      },
      required: ['cmd'],
    }
    registerTool('override_tool', 'override test', schema, vi.fn(), 'auto', {
      inputSchemaOverride: override,
    })

    const defs = listToolDefs()
    const def = defs.find((d) => d.name === 'override_tool')
    expect(def).toBeDefined()
    expect(def!.input_schema).toEqual(override)
    // 确保不是 zodToJsonSchema 的输出
    expect(def!.input_schema).not.toEqual({
      type: 'object',
      properties: { cmd: { type: 'string' } },
      required: ['cmd'],
    })
  })

  it('unregisterByPrefix 按前缀批量注销', () => {
    registerTool('mcp__server1__tool_a', 'a', z.object({}), vi.fn())
    registerTool('mcp__server1__tool_b', 'b', z.object({}), vi.fn())
    registerTool('mcp__server2__tool_c', 'c', z.object({}), vi.fn())
    registerTool('builtin_tool', 'builtin', z.object({}), vi.fn())

    const removed = unregisterByPrefix('mcp__server1__')
    expect(removed).toBe(2)
    expect(hasTool('mcp__server1__tool_a')).toBe(false)
    expect(hasTool('mcp__server1__tool_b')).toBe(false)
    expect(hasTool('mcp__server2__tool_c')).toBe(true)
    expect(hasTool('builtin_tool')).toBe(true)
  })

  it('hasTool 检测工具是否已注册', () => {
    registerTool('exists_tool', 'test', z.object({}), vi.fn())
    expect(hasTool('exists_tool')).toBe(true)
    expect(hasTool('nonexistent')).toBe(false)
  })

  it('approvalMode=always：handler throw 不自动重试（I4）', async () => {
    const schema = z.object({ cmd: z.string() })
    const handler = vi.fn().mockRejectedValue(new Error('boom'))
    registerTool('always_no_retry', 'x', schema, handler, 'always')

    const result = await executeTool(
      'always_no_retry',
      { cmd: 'x' },
      'tu_nr',
      { onApprove: vi.fn().mockResolvedValue({ approved: true }) },
    )

    expect(handler).toHaveBeenCalledTimes(1)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('boom')
  })

  it('listBuiltinToolDefs 排除 mcp__*；listAgentToolDefs 按 expose 白名单注入（R1/R2）', () => {
    registerTool('web_search', 'w', z.object({}), vi.fn())
    registerTool('mcp__sid-1__search', 'm', z.object({}), vi.fn())
    registerTool('mcp__sid-2__fetch', 'm2', z.object({}), vi.fn())

    const builtin = listBuiltinToolDefs().map((d) => d.name)
    expect(builtin).toContain('web_search')
    expect(builtin).not.toContain('mcp__sid-1__search')
    expect(builtin).not.toContain('mcp__sid-2__fetch')

    const exposed = listAgentToolDefs(['sid-1']).map((d) => d.name)
    expect(exposed).toContain('web_search')
    expect(exposed).toContain('mcp__sid-1__search')
    expect(exposed).not.toContain('mcp__sid-2__fetch')

    expect(listToolDefs().map((d) => d.name)).toContain('mcp__sid-2__fetch')
  })

  it('mcpServerIdFromToolName 解析 UUID serverId', () => {
    expect(
      mcpServerIdFromToolName('mcp__550e8400-e29b-41d4-a716-446655440000__web_search'),
    ).toBe('550e8400-e29b-41d4-a716-446655440000')
    expect(mcpServerIdFromToolName('shell_run')).toBeNull()
    expect(mcpServerIdFromToolName('mcp__only')).toBeNull()
  })
})
