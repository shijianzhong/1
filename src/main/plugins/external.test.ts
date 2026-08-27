import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ExternalPlugin,
  EXTERNAL_TOOL_PREFIX,
  isValidExternalId,
  type ExternalPluginManifest,
} from './external'
import { pluginEvents } from './events'
import type { PluginHost, PluginToolSpec, PluginHandle } from './contracts'
import type { GeneratedBSpec } from '@shared/types'

function makeManifest(
  spec: GeneratedBSpec,
  opts: { id?: string; trustedBy?: ExternalPluginManifest['trustedBy'] } = {},
): ExternalPluginManifest {
  const id = opts.id ?? 'ext_test1'
  return {
    id,
    kind: 'external',
    name: spec.name,
    version: '0.1.0',
    description: spec.description,
    enabled: true,
    source: 'external',
    specExternal: spec,
    trustedBy: opts.trustedBy ?? null,
    effects: { tools: [`${EXTERNAL_TOOL_PREFIX}${spec.name}`], storage: [] },
  }
}

function makeHost() {
  const register = vi.fn((_spec: PluginToolSpec): PluginHandle => ({
    name: _spec.name,
    unregister: vi.fn(),
  }))
  const host = {
    tools: { register, unregister: vi.fn(() => 0), list: vi.fn(() => []) },
    events: pluginEvents,
  } as unknown as PluginHost
  return { host, register }
}

const validSpec: GeneratedBSpec = {
  name: 'my_ext_tool',
  description: 'an external code tool',
  inputSchema: { type: 'object' },
  handlerSource: "return 'ok'",
}

describe('isValidExternalId（路径穿越防护）', () => {
  it('ext_<slug> 合法', () => {
    expect(isValidExternalId('ext_abc123')).toBe(true)
  })
  it('与 A/B 前缀互斥（gen_/genb_ 拒绝）', () => {
    expect(isValidExternalId('gen_abc')).toBe(false)
    expect(isValidExternalId('genb_abc')).toBe(false)
  })
  it('含非字母数字或路径片段拒绝', () => {
    expect(isValidExternalId('ext_../etc')).toBe(false)
    expect(isValidExternalId('ext a')).toBe(false)
    expect(isValidExternalId('')).toBe(false)
  })
})

describe('ExternalPlugin.onLoad（信任三态 fail-closed，与 generated_b 同构）', () => {
  beforeEach(() => pluginEvents.clear())

  it('未信任 → 注册占位工具（auto），handler 返 trusted_required', async () => {
    const { host, register } = makeHost()
    await new ExternalPlugin(makeManifest(validSpec, { trustedBy: null })).onLoad(host)
    expect(register).toHaveBeenCalledTimes(1)
    const specArg = register.mock.calls[0][0]
    expect(specArg.name).toBe(`${EXTERNAL_TOOL_PREFIX}my_ext_tool`)
    expect(specArg.approvalMode).toBe('auto')
    // 占位 handler 调到只返 trusted_required，不执行用户代码
    const handler = specArg.handler as (a: unknown, c: unknown) => Promise<unknown>
    const out = (await handler({}, {})) as { content: string; isError: boolean }
    expect(out.isError).toBe(true)
    expect(out.content).toContain('trusted_required')
  })

  it('已信任 → 注册真 code handler（always）', async () => {
    const { host, register } = makeHost()
    await new ExternalPlugin(
      makeManifest(validSpec, { trustedBy: { userId: 'local', ts: 1 } }),
    ).onLoad(host)
    expect(register).toHaveBeenCalledTimes(1)
    const specArg = register.mock.calls[0][0]
    expect(specArg.name).toBe(`${EXTERNAL_TOOL_PREFIX}my_ext_tool`)
    expect(specArg.approvalMode).toBe('always')
    expect(typeof specArg.handler).toBe('function')
  })

  it('非法 spec（handlerSource 空）→ 不注册 + emit failed', async () => {
    const { host, register } = makeHost()
    const got: Array<{ status?: string; reason?: string }> = []
    pluginEvents.on('plugin.registered', (p) => got.push(p))
    await new ExternalPlugin(
      makeManifest({ ...validSpec, handlerSource: '' }, { trustedBy: null }),
    ).onLoad(host)
    expect(register).not.toHaveBeenCalled()
    expect(got[0]?.status).toBe('failed')
    expect(got[0]?.reason).toBe('handler_source_empty')
  })

  it('合法 → emit plugin.registered status=ok', async () => {
    const { host } = makeHost()
    const got: Array<{ status?: string }> = []
    pluginEvents.on('plugin.registered', (p) => got.push(p))
    await new ExternalPlugin(makeManifest(validSpec, { trustedBy: null })).onLoad(host)
    expect(got[0]?.status).toBe('ok')
  })
})
