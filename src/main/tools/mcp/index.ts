import { loadMcpConfig } from './config'
import { connectServer, disconnectAll, setOnUnexpectedDisconnect } from './client'
import { registerMcpTools, unregisterMcpTools } from './adapter'
import { logger } from '../../logger'

// —— MCP 模块入口 ——
// 启动时自动连接 enabled 的服务器，退出时 disconnectAll。
// 意外断连时通过回调统一注销工具（I1 修复：避免 client→adapter 循环依赖）。

// 注册意外断连回调 → 桥接 adapter.unregisterMcpTools
setOnUnexpectedDisconnect((serverId) => {
  const removed = unregisterMcpTools(serverId)
  if (removed > 0) {
    logger.info(`[mcp] auto-unregistered ${removed} tool(s) after unexpected disconnect: ${serverId}`)
  }
})

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
export { loadMcpConfig, addMcpServer, updateMcpServer, removeMcpServer, resolveSecrets, sanitizeConfig } from './config'
export { connectServer, disconnectServer, isConnected, listServerTools } from './client'
export { registerMcpTools, unregisterMcpTools } from './adapter'
