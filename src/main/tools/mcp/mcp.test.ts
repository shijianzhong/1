import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'
import {
  clearTools,
  registerTool,
  unregisterByPrefix,
  hasTool,
  listToolDefs,
  executeTool,
} from '../registry'

// —— MCP adapter 单元测试 ——
// 测试 adapter 注册/注销逻辑、AJV 校验、工具命名前缀。
// client.ts 的真实 MCP 连接需要子进程/HTTP 服务器，不适合单元测试，
// 这里 mock listServerTools/callServerTool 来测试 adapter 行为。

// mock client 模块
vi.mock('./client', () => ({
  connectServer: vi.fn(),
  disconnectServer: vi.fn(),
  disconnectAll: vi.fn(),
  getClient: vi.fn(() => null),
  isConnected: vi.fn(() => false),
  listServerTools: vi.fn(),
  callServerTool: vi.fn(),
}))

import { registerMcpTools, unregisterMcpTools } from './adapter'
import { listServerTools, callServerTool } from './client'
import type { McpServerConfig } from '@shared/types'

const mockConfig: McpServerConfig = {
  id: 'test-server-1',
  name: 'Test Server',
  transport: 'stdio',
  command: 'echo',
  args: ['hello'],
  enabled: true,
  approvalMode: 'always',
}

const mockCtx = {
  onApprove: vi.fn().mockResolvedValue({ approved: true }),
}

describe('MCP adapter', () => {
  beforeEach(() => {
    clearTools()
    vi.clearAllMocks()
  })

  afterEach(() => {
    clearTools()
  })

  it('registerMcpTools: 将 MCP 工具注册到 registry，命名 mcp__{serverId}__{toolName}', async () => {
    vi.mocked(listServerTools).mockResolvedValue([
      {
        name: 'search',
        description: 'Search the web',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
        },
      },
      {
        name: 'fetch',
        description: 'Fetch a URL',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
          },
          required: ['url'],
        },
      },
    ])

    const count = await registerMcpTools(mockConfig)
    expect(count).toBe(2)

    const names = listToolDefs().map((t) => t.name)
    expect(names).toContain('mcp__test-server-1__search')
    expect(names).toContain('mcp__test-server-1__fetch')
  })

  it('registerMcpTools: inputSchemaOverride 直传 JSON Schema 给 LLM', async () => {
    const schema = {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    }
    vi.mocked(listServerTools).mockResolvedValue([
      { name: 'search', description: 'Search', inputSchema: schema },
    ])

    await registerMcpTools(mockConfig)

    const def = listToolDefs().find((t) => t.name === 'mcp__test-server-1__search')
    expect(def).toBeDefined()
    expect(def!.input_schema).toEqual(schema)
  })

  it('registerMcpTools: 无 description 的工具使用默认描述', async () => {
    vi.mocked(listServerTools).mockResolvedValue([
      { name: 'noop', inputSchema: { type: 'object', properties: {} } },
    ])

    await registerMcpTools(mockConfig)

    const def = listToolDefs().find((t) => t.name === 'mcp__test-server-1__noop')
    expect(def).toBeDefined()
    expect(def!.description).toContain('MCP tool: noop')
    expect(def!.description).toContain('Test Server')
  })

  it('registerMcpTools: 无 inputSchema 的工具使用空 object schema', async () => {
    // adapter 对缺失 inputSchema 做 fallback { type: 'object', properties: {} }
    vi.mocked(listServerTools).mockResolvedValue([
      { name: 'noop' } as never,
    ])

    await registerMcpTools(mockConfig)

    const def = listToolDefs().find((t) => t.name === 'mcp__test-server-1__noop')
    expect(def).toBeDefined()
    expect(def!.input_schema).toEqual({ type: 'object', properties: {} })
  })

  it('unregisterMcpTools: 按前缀注销工具', async () => {
    vi.mocked(listServerTools).mockResolvedValue([
      { name: 'tool_a', description: 'A', inputSchema: { type: 'object', properties: {} } },
      { name: 'tool_b', description: 'B', inputSchema: { type: 'object', properties: {} } },
    ])

    await registerMcpTools(mockConfig)
    expect(listToolDefs().filter((t) => t.name.startsWith('mcp__')).length).toBe(2)

    const removed = unregisterMcpTools(mockConfig.id)
    expect(removed).toBe(2)
    expect(listToolDefs().filter((t) => t.name.startsWith('mcp__')).length).toBe(0)
  })

  it('unregisterMcpTools: 不影响其他工具', async () => {
    // 注册一个普通工具
    registerTool('shell_run', 'Shell', z.object({ command: z.string() }), () => null)

    vi.mocked(listServerTools).mockResolvedValue([
      { name: 'search', description: 'Search', inputSchema: { type: 'object', properties: {} } },
    ])
    await registerMcpTools(mockConfig)

    unregisterMcpTools(mockConfig.id)

    expect(hasTool('shell_run')).toBe(true)
    expect(hasTool('mcp__test-server-1__search')).toBe(false)
  })

  it('AJV 校验: 入参不符合 schema 时返回错误', async () => {
    vi.mocked(listServerTools).mockResolvedValue([
      {
        name: 'search',
        description: 'Search',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ])
    vi.mocked(callServerTool).mockResolvedValue({
      content: [{ type: 'text', text: 'result' }],
    })

    await registerMcpTools(mockConfig)

    // 缺少 required 字段 query
    const result = await executeTool('mcp__test-server-1__search', {}, 'toolu_test', mockCtx)
    const parsed = JSON.parse(result.content)
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toBe('invalid_args')
    // callServerTool 不应被调用
    expect(vi.mocked(callServerTool)).not.toHaveBeenCalled()
  })

  it('AJV 校验: 入参合法时正常调用 MCP 工具', async () => {
    vi.mocked(listServerTools).mockResolvedValue([
      {
        name: 'search',
        description: 'Search',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ])
    vi.mocked(callServerTool).mockResolvedValue({
      content: [{ type: 'text', text: 'search results here' }],
      isError: false,
    })

    await registerMcpTools(mockConfig)

    const result = await executeTool(
      'mcp__test-server-1__search',
      { query: 'hello world' },
      'toolu_test',
      mockCtx,
    )
    const parsed = JSON.parse(result.content)
    expect(parsed.ok).toBe(true)
    expect(parsed.content).toBe('search results here')
    expect(vi.mocked(callServerTool)).toHaveBeenCalledWith(
      'test-server-1',
      'search',
      { query: 'hello world' },
      undefined,
    )
  })

  it('MCP 工具返回 isError=true 时透传错误状态', async () => {
    vi.mocked(listServerTools).mockResolvedValue([
      {
        name: 'dangerous',
        description: 'Dangerous tool',
        inputSchema: { type: 'object', properties: {} },
      },
    ])
    vi.mocked(callServerTool).mockResolvedValue({
      content: [{ type: 'text', text: 'Permission denied' }],
      isError: true,
    })

    await registerMcpTools(mockConfig)

    const result = await executeTool('mcp__test-server-1__dangerous', {}, 'toolu_test', mockCtx)
    const parsed = JSON.parse(result.content)
    expect(parsed.ok).toBe(false)
    expect(parsed.isError).toBe(true)
  })

  it('callServerTool 抛异常时返回结构化错误', async () => {
    vi.mocked(listServerTools).mockResolvedValue([
      {
        name: 'fail',
        description: 'Failing tool',
        inputSchema: { type: 'object', properties: {} },
      },
    ])
    vi.mocked(callServerTool).mockRejectedValue(new Error('Connection lost'))

    await registerMcpTools(mockConfig)

    const result = await executeTool('mcp__test-server-1__fail', {}, 'toolu_test', mockCtx)
    const parsed = JSON.parse(result.content)
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toBe('mcp_tool_call_failed')
    expect(parsed.messageKey).toBe('errors.mcp.tool_call_failed')
  })

  it('approvalMode 默认 always: 不注入 onApprove 时返回 approval_unavailable', async () => {
    vi.mocked(listServerTools).mockResolvedValue([
      { name: 'tool', description: 'T', inputSchema: { type: 'object', properties: {} } },
    ])

    await registerMcpTools(mockConfig)

    const result = await executeTool('mcp__test-server-1__tool', {}, 'toolu_test', {})
    const parsed = JSON.parse(result.content)
    expect(parsed.error).toBe('approval_unavailable')
    expect(parsed.messageKey).toBe('errors.tools.approval_unavailable')
  })

  it('approvalMode=auto: 不需要审批直接执行', async () => {
    const autoConfig: McpServerConfig = { ...mockConfig, approvalMode: 'auto' }
    vi.mocked(listServerTools).mockResolvedValue([
      { name: 'tool', description: 'T', inputSchema: { type: 'object', properties: {} } },
    ])
    vi.mocked(callServerTool).mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
    })

    await registerMcpTools(autoConfig)

    const result = await executeTool('mcp__test-server-1__tool', {}, 'toolu_test', {})
    const parsed = JSON.parse(result.content)
    expect(parsed.ok).toBe(true)
    expect(parsed.content).toBe('ok')
  })
})
