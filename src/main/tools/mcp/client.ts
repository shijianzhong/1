import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServerConfig } from '@shared/types'
import { logger } from '../../logger'
import { resolveSecrets } from './config'

// —— MCP 客户端管理器 ——
// 管理所有已连接的 MCP 服务器客户端，提供 connect/disconnect/callTool 能力。
// transport 支持 stdio（子进程）和 http（Streamable HTTP + SSE fallback）。

interface ManagedClient {
  client: Client
  config: McpServerConfig
}

const clients = new Map<string, ManagedClient>()

/** 意外断连回调（由 index.ts 注册 → 调用 unregisterMcpTools 清理工具注册表） */
let onUnexpectedDisconnectFn: ((serverId: string) => void) | null = null

/** 注册意外断连回调（index.ts 调用，桥接 adapter.unregisterMcpTools 避免循环依赖） */
export function setOnUnexpectedDisconnect(fn: (serverId: string) => void): void {
  onUnexpectedDisconnectFn = fn
}

/** 连接到 MCP 服务器（如已存在旧连接先断开） */
export async function connectServer(config: McpServerConfig): Promise<void> {
  // 先断开旧连接
  await disconnectServer(config.id)

  // I3 修复：解析 vault 引用 → 明文（env/headers 密钥不在配置文件中明文存储）
  const resolved = resolveSecrets(config)

  const client = new Client(
    { name: 'one-desktop', version: '1.0.0' },
    { capabilities: {} },
  )

  let transport: StdioClientTransport | StreamableHTTPClientTransport

  if (resolved.transport === 'stdio') {
    if (!resolved.command) throw new Error('stdio transport requires "command"')
    transport = new StdioClientTransport({
      command: resolved.command,
      args: resolved.args,
      env: resolved.env,
      cwd: resolved.cwd,
      stderr: 'pipe',
    })
  } else {
    if (!resolved.url) throw new Error('http transport requires "url"')
    transport = new StreamableHTTPClientTransport(
      new URL(resolved.url),
      { requestInit: { headers: resolved.headers ?? {} } },
    )
  }

  // 意外断连时清理 map + 注销工具（正常 disconnect 已提前 delete，此处为 no-op）
  transport.onclose = (): void => {
    if (clients.has(config.id)) {
      logger.warn(`[mcp] server disconnected unexpectedly: ${config.name} (${config.id})`)
      clients.delete(config.id)
      // 通知 adapter 注销该 server 的所有工具（I1 修复：teardown 统一）
      onUnexpectedDisconnectFn?.(config.id)
    }
  }
  transport.onerror = (error: Error): void => {
    logger.error(`[mcp] transport error: ${config.name} (${config.id})`, error)
  }

  await client.connect(transport)
  clients.set(config.id, { client, config })
  logger.info(`[mcp] connected: ${config.name} (${config.id}, transport=${config.transport})`)
}

/** 断开指定服务器连接 */
export async function disconnectServer(id: string): Promise<void> {
  const managed = clients.get(id)
  if (!managed) return
  clients.delete(id) // 先从 map 移除，防止 onclose 重复处理
  try {
    await managed.client.close()
  } catch (e) {
    logger.warn(`[mcp] disconnect error: ${id}`, e)
  }
  logger.info(`[mcp] disconnected: ${id}`)
}

/** 断开所有服务器（app 退出前调用） */
export async function disconnectAll(): Promise<void> {
  const ids = Array.from(clients.keys())
  if (ids.length === 0) return
  logger.info(`[mcp] disconnecting ${ids.length} server(s)`)
  await Promise.allSettled(ids.map(disconnectServer))
}

/** 获取已连接的 Client（未连接返回 null） */
export function getClient(id: string): Client | null {
  return clients.get(id)?.client ?? null
}

/** 检查连接状态 */
export function isConnected(id: string): boolean {
  return clients.has(id)
}

/** 列出服务器的工具 */
export async function listServerTools(id: string) {
  const client = getClient(id)
  if (!client) return []
  const result = await client.listTools()
  return result.tools
}

/** 调用服务器上的工具 */
export async function callServerTool(
  id: string,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const client = getClient(id)
  if (!client) throw new Error(`MCP server not connected: ${id}`)
  return client.callTool({ name, arguments: args }, undefined, { signal })
}
