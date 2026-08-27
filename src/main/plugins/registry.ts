// —— 插件统一生命周期编排（docs/PLUGIN_ARCHITECTURE.md §5 Stage 1 收口延伸）——
// 聚合各 kind 的启动加载与退出卸载为单一入口，让 app 启动/退出只调一处，
// 不分散调用 initMcpServers/initGeneratedPlugins/...。对齐 MCP 已有的
// initMcpServers/disconnectAll 模式并推广到全部 kind（loadEvery → startAll
// enabled → stopOnUninstall → disposeOnExit）。
//
// 各 kind 的 init/disconnect 实现仍各自保留（generated/generatedB/external 在
// 各自模块，MCP 在 tools/mcp），本层只做编排聚合，不引入新的生命周期语义，
// 也不破坏既有单 kind 的调用与测试。

import type { PluginHost } from './contracts'
import { initMcpServers, disconnectAll as disconnectAllMcp } from '../tools/mcp'
import { initGeneratedPlugins, disconnectAll as disconnectAllGenerated } from './generated'
import { initGeneratedBPlugins, disconnectAllB } from './generatedB'
import { initExternalPlugins, disconnectAllExternal } from './external'

/**
 * 启动加载全部插件（loadEvery + startAll enabled）。
 * 各 kind 内部已用 Promise.allSettled 非阻塞、单失败不阻塞其他；
 * 此处再用 allSettled 聚合，确保某个 kind 的 init 抛错不影响其余。
 */
export async function initAllPlugins(host: PluginHost): Promise<void> {
  await Promise.allSettled([
    initMcpServers(),
    initGeneratedPlugins(host),
    initGeneratedBPlugins(host),
    initExternalPlugins(host),
  ])
}

/** 进程退出卸载全部插件（disposeOnExit），best-effort 不阻塞退出 */
export async function disposeAllPlugins(): Promise<void> {
  await Promise.allSettled([
    disconnectAllMcp(),
    disconnectAllGenerated(),
    disconnectAllB(),
    disconnectAllExternal(),
  ])
}
