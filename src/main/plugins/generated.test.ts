import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GeneratedPlugin, GENERATED_TOOL_PREFIX, type GeneratedPluginManifest } from './generated'
import { pluginEvents } from './events'
import type { PluginHost, PluginToolSpec, PluginHandle } from './contracts'
import type { GeneratedPluginSpec } from '@shared/types'

function makeManifest(spec: GeneratedPluginSpec, id = 'gen_test1'): GeneratedPluginManifest {
  return {
    id,
    kind: 'generated',
    name: spec.name,
    version: '0.1.0',
    description: spec.description,
    enabled: true,
    source: 'builtin',
    spec,
    effects: { tools: [`${GENERATED_TOOL_PREFIX}${spec.name}`], storage: [] },
  }
}

function makeHost() {
  const register = vi.fn((_spec: PluginToolSpec): PluginHandle => ({ name: _spec.name, unregister: vi.fn() }))
  const host = {
    tools: { register, unregister: vi.fn(() => 0), list: vi.fn(() => []) },
    events: pluginEvents,
  } as unknown as PluginHost
  return { host, register }
}

const validSpec: GeneratedPluginSpec = {
  name: 'my_reader',
  description: 'read a file',
  inputSchema: { type: 'object' },
  executeAction: { action: 'file_read', params: { path: '/tmp/x' } },
}

describe('GeneratedPlugin.onLoad（注册点 fail-closed）', () => {
  beforeEach(() => pluginEvents.clear())

  it('合法 spec → 注册工具到 host.tools（命名空间前缀 + auto 审批）', async () => {
    const { host, register } = makeHost()
    await new GeneratedPlugin(makeManifest(validSpec)).onLoad(host)
    expect(register).toHaveBeenCalledTimes(1)
    const specArg = register.mock.calls[0][0]
    expect(specArg.name).toBe(`${GENERATED_TOOL_PREFIX}my_reader`)
    expect(specArg.approvalMode).toBe('auto')
  })

  it('合法 spec → 发射 plugin.registered status=ok', async () => {
    const { host } = makeHost()
    const got: Array<{ status?: string; reason?: string }> = []
    pluginEvents.on('plugin.registered', (p) => got.push(p))
    await new GeneratedPlugin(makeManifest(validSpec)).onLoad(host)
    expect(got[0]?.status).toBe('ok')
  })

  it('非法 spec（action 不在白名单）→ 拒绝注册并标记 failed', async () => {
    const { host, register } = makeHost()
    const bad: GeneratedPluginSpec = {
      ...validSpec,
      name: 'bad',
      executeAction: { action: 'rm_rf', params: {} },
    }
    const got: Array<{ status?: string; reason?: string }> = []
    pluginEvents.on('plugin.registered', (p) => got.push(p))
    await new GeneratedPlugin(makeManifest(bad)).onLoad(host)
    expect(register).not.toHaveBeenCalled()
    expect(got[0]?.status).toBe('failed')
    expect(got[0]?.reason).toBe('action_not_whitelisted')
  })

  it('非法 spec（参数 bounds 越界）→ 拒绝注册', async () => {
    const { host, register } = makeHost()
    const bad: GeneratedPluginSpec = {
      ...validSpec,
      name: 'bad',
      executeAction: { action: 'file_search', params: { query: 'q', maxResults: 999 } },
    }
    await new GeneratedPlugin(makeManifest(bad)).onLoad(host)
    expect(register).not.toHaveBeenCalled()
  })
})
