import { describe, it, expect, vi, beforeEach } from 'vitest'

// 各 kind 的 init/disconnect 在单测中 mock，避免真连 MCP / 真读盘
vi.mock('../tools/mcp', () => ({
  initMcpServers: vi.fn().mockResolvedValue(undefined),
  disconnectAll: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('./generated', () => ({
  initGeneratedPlugins: vi.fn().mockResolvedValue(undefined),
  disconnectAll: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('./generatedB', () => ({
  initGeneratedBPlugins: vi.fn().mockResolvedValue(undefined),
  disconnectAllB: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('./external', () => ({
  initExternalPlugins: vi.fn().mockResolvedValue(undefined),
  disconnectAllExternal: vi.fn().mockResolvedValue(undefined),
}))

import { initAllPlugins, disposeAllPlugins } from './registry'
import { initMcpServers, disconnectAll } from '../tools/mcp'
import { initGeneratedPlugins, disconnectAll as disconnectAllGenerated } from './generated'
import { initGeneratedBPlugins, disconnectAllB } from './generatedB'
import { initExternalPlugins, disconnectAllExternal } from './external'
import { pluginHost } from './host'

describe('plugin registry orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('initAllPlugins 聚合调用全部 kind 的 init', async () => {
    await initAllPlugins(pluginHost)
    expect(initMcpServers).toHaveBeenCalledTimes(1)
    expect(initGeneratedPlugins).toHaveBeenCalledWith(pluginHost)
    expect(initGeneratedBPlugins).toHaveBeenCalledWith(pluginHost)
    expect(initExternalPlugins).toHaveBeenCalledWith(pluginHost)
  })

  it('disposeAllPlugins 聚合调用全部 kind 的 disconnect', async () => {
    await disposeAllPlugins()
    expect(disconnectAll).toHaveBeenCalledTimes(1)
    expect(disconnectAllGenerated).toHaveBeenCalledTimes(1)
    expect(disconnectAllB).toHaveBeenCalledTimes(1)
    expect(disconnectAllExternal).toHaveBeenCalledTimes(1)
  })

  it('某个 kind init 抛错不阻塞其余（allSettled 容错）', async () => {
    ;(initGeneratedPlugins as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('boom'),
    )
    // 不应抛出
    await expect(initAllPlugins(pluginHost)).resolves.toBeUndefined()
    // 其余 kind 仍被调用
    expect(initMcpServers).toHaveBeenCalledTimes(1)
    expect(initGeneratedBPlugins).toHaveBeenCalledWith(pluginHost)
    expect(initExternalPlugins).toHaveBeenCalledWith(pluginHost)
  })
})
