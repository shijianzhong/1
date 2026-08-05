import { loadMcpConfig } from './config'
import { connectServer, disconnectAll } from './client'
import { registerMcpTools } from './adapter'
import { logger } from '../../logger'

// —— MCP 模块入口 ——
// 启动时自动连接 enabled 的服务器，退出时 disconnectAll。

/** 启动时初始化：加载配置 + 并行连接所有 enabled 的服务器 */
export async function initMcpServers(): Promise<void> {
  const configs = await loadMcpConfig()
  const enabled = configs.filter((c) => c.enabled)
  if (enabled.length === 0) return

  logger.info(`[mcp] auto-connecting ${enabled.length} enabled server(s)`)
  // 并行连接，单个失败不影响其他
  await Promise.allSettled(
    enabled.map(async (config) => {
      try {
        await connectServer(config)
        await registerMcpTools(config)
      } catch (e) {
        logger.error(`[mcp] auto-connect failed: ${config.name} (${config.id})`, e)
      }
    }),
  )
}

export { disconnectAll }
export { loadMcpConfig, addMcpServer, updateMcpServer, removeMcpServer } from './config'
export { connectServer, disconnectServer, isConnected, listServerTools } from './client'
export { registerMcpTools, unregisterMcpTools } from './adapter'
