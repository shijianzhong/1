import { IpcErrorThrow } from '@shared/types'
import { withHandler } from './handler'
import {
  loadMcpConfig,
  addMcpServer,
  updateMcpServer,
  removeMcpServer,
  connectServer,
  disconnectServer,
  isConnected,
  listServerTools,
  registerMcpTools,
  unregisterMcpTools,
  sanitizeConfig,
} from '../tools/mcp'
import type { McpServerConfig, McpServerStatus } from '@shared/types'
import { logger } from '../logger'

// —— MCP IPC 处理器 ——
// 渲染层通过 window.one.mcp.* 管理 MCP 服务器配置与连接。

export function registerMcpHandlers(): void {
  // 列出所有服务器配置 + 运行时状态
  withHandler<McpServerStatus[]>('mcp:listServers', async () => {
    const configs = await loadMcpConfig()
    const statuses: McpServerStatus[] = []
    for (const config of configs) {
      const connected = isConnected(config.id)
      let tools: Array<{ name: string; description?: string }> = []
      if (connected) {
        try {
          tools = (await listServerTools(config.id)).map((t) => ({
            name: t.name,
            description: t.description,
          }))
        } catch {
          // ignore — 工具列表获取失败不阻塞状态返回
        }
      }
      statuses.push({
        config: sanitizeConfig(config), // I3 修复：env/headers 脱敏，不暴露密钥到渲染层
        connected,
        toolCount: tools.length,
        tools,
      })
    }
    return statuses
  })

  // 添加服务器配置
  withHandler<McpServerConfig>('mcp:addServer', async (_e, input) => {
    const config = await addMcpServer(input as Omit<McpServerConfig, 'id'>)
    return config
  })

  // 更新服务器配置（如已连接则断开重连）
  withHandler<McpServerConfig | null>('mcp:updateServer', async (_e, input) => {
    const { id, ...updates } = input as { id: string } & Partial<
      Omit<McpServerConfig, 'id'>
    >
    // 已连接 → 先注销工具 + 断开
    if (isConnected(id)) {
      unregisterMcpTools(id)
      await disconnectServer(id)
    }
    const config = await updateMcpServer(id, updates)
    // enabled 且更新成功 → 自动重连
    if (config?.enabled) {
      try {
        await connectServer(config)
        await registerMcpTools(config)
      } catch (e) {
        logger.error(`[mcp] reconnect after update failed: ${config.name}`, e)
      }
    }
    return config
  })

  // 删除服务器配置（如已连接先断开）
  withHandler<boolean>('mcp:removeServer', async (_e, idRaw) => {
    const id = idRaw as string
    if (isConnected(id)) {
      unregisterMcpTools(id)
      await disconnectServer(id)
    }
    return removeMcpServer(id)
  })

  // 连接到服务器 + 注册工具（I2 修复：重连前先注销旧工具，避免 hasTool 冲突导致 toolCount=0）
  withHandler<{ toolCount: number }>('mcp:connectServer', async (_e, idRaw) => {
    const id = idRaw as string
    const configs = await loadMcpConfig()
    const config = configs.find((s) => s.id === id)
    if (!config) throw new IpcErrorThrow('errors.mcp.server_not_found')
    // 先注销旧工具（重连场景：旧工具仍在 registry → hasTool 拦截 → 注册 0 个）
    unregisterMcpTools(id)
    await connectServer(config)
    const count = await registerMcpTools(config)
    return { toolCount: count }
  })

  // 断开服务器 + 注销工具
  withHandler<void>('mcp:disconnectServer', async (_e, idRaw) => {
    const id = idRaw as string
    unregisterMcpTools(id)
    await disconnectServer(id)
  })

  // 测试连接（连接 → 列工具 → 断开；不注册工具、不持久化）
  withHandler<{ toolCount: number; tools: Array<{ name: string; description?: string }> }>(
    'mcp:testServer',
    async (_e, input) => {
      const config = input as Omit<McpServerConfig, 'id'>
      const testConfig: McpServerConfig = { ...config, id: `test_${Date.now()}` }
      try {
        await connectServer(testConfig)
        const tools = await listServerTools(testConfig.id)
        await disconnectServer(testConfig.id)
        return {
          toolCount: tools.length,
          tools: tools.map((t) => ({ name: t.name, description: t.description })),
        }
      } catch (e) {
        await disconnectServer(testConfig.id)
        throw e
      }
    },
  )
}
