import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { rmSync } from 'node:fs'

// 持久化路径指向临时目录（save/setBPluginTrusted 测试碰盘；onLoad 纯内存不碰盘）
vi.mock('../storage/paths', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'genb-test-'))
  return {
    getGeneratedPluginsDir: () => dir,
    getGeneratedPluginDir: (id: string) => join(dir, id),
    getGeneratedPluginManifestPath: (id: string) => join(dir, id, 'manifest.json'),
    getGeneratedBHandlerPath: (id: string) => join(dir, id, 'handler.js'),
  }
})

import {
  GeneratedBPlugin,
  GENERATED_B_TOOL_PREFIX,
  loadGeneratedBPluginManifest,
  saveGeneratedBPlugin,
  setBPluginTrusted,
  type GeneratedBPluginManifest,
} from './generatedB'
import { getGeneratedPluginsDir } from '../storage/paths'
import { validateGeneratedBSpec } from './whitelist'
import { pluginEvents } from './events'
import { IpcErrorThrow } from '@shared/types'
import type { PluginHost, PluginToolSpec, PluginHandle } from './contracts'
import type { GeneratedBSpec, PluginConfigField } from '@shared/types'

afterAll(() => {
  rmSync(getGeneratedPluginsDir(), { recursive: true, force: true })
})

function makeManifest(
  spec: GeneratedBSpec,
  opts: {
    id?: string
    trustedBy?: GeneratedBPluginManifest['trustedBy']
    configSchema?: PluginConfigField[]
  } = {},
): GeneratedBPluginManifest {
  const id = opts.id ?? 'genb_test1'
  return {
    id,
    kind: 'generated_b',
    name: spec.name,
    version: '0.1.0',
    description: spec.description,
    enabled: true,
    source: 'builtin',
    specB: spec,
    trustedBy: opts.trustedBy ?? null,
    configSchema: opts.configSchema,
    effects: { tools: [`${GENERATED_B_TOOL_PREFIX}${spec.name}`], storage: [] },
  }
}

function makeHost(
  opts: { secrets?: { get: (k: string) => Promise<string | null> } } = {},
) {
  const register = vi.fn((_spec: PluginToolSpec): PluginHandle => ({
    name: _spec.name,
    unregister: vi.fn(),
  }))
  const host = {
    tools: { register, unregister: vi.fn(() => 0), list: vi.fn(() => []) },
    events: pluginEvents,
    ...(opts.secrets ? { secrets: opts.secrets } : {}),
  } as unknown as PluginHost
  return { host, register }
}

const validSpec: GeneratedBSpec = {
  name: 'my_tool',
  description: 'a code tool',
  inputSchema: { type: 'object' },
  handlerSource: "return 'ok'",
}

describe('validateGeneratedBSpec（fail-closed 闸门）', () => {
  it('handlerSource 为空 → handler_source_empty', () => {
    const r = validateGeneratedBSpec({ ...validSpec, handlerSource: '   ' })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('handler_source_empty')
  })

  it('handlerSource 语法错 → compile_failed', () => {
    const r = validateGeneratedBSpec({ ...validSpec, handlerSource: 'const x = ;' })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('compile_failed')
  })

  it('inputSchema 非 object 类型 → invalid_input_schema', () => {
    const r = validateGeneratedBSpec({
      ...validSpec,
      inputSchema: { type: 'string' } as unknown as Record<string, unknown>,
    })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('invalid_input_schema')
  })

  it('合法 spec → ok', () => {
    const r = validateGeneratedBSpec(validSpec)
    expect(r.ok).toBe(true)
  })
})

describe('GeneratedBPlugin.onLoad（信任三态 fail-closed）', () => {
  beforeEach(() => pluginEvents.clear())

  it('未信任 → 注册占位工具（auto），handler 返 trusted_required', async () => {
    const { host, register } = makeHost()
    await new GeneratedBPlugin(makeManifest(validSpec, { trustedBy: null })).onLoad(host)
    expect(register).toHaveBeenCalledTimes(1)
    const specArg = register.mock.calls[0][0]
    expect(specArg.name).toBe(`${GENERATED_B_TOOL_PREFIX}my_tool`)
    expect(specArg.approvalMode).toBe('auto')
    // 占位 handler 调到只返 trusted_required，不执行用户代码
    const handler = specArg.handler as (a: unknown, c: unknown) => Promise<unknown>
    const out = (await handler({}, {})) as { content: string; isError: boolean }
    expect(out.isError).toBe(true)
    expect(out.content).toContain('trusted_required')
  })

  it('已信任 → 注册真 code handler（always）', async () => {
    const { host, register } = makeHost()
    await new GeneratedBPlugin(
      makeManifest(validSpec, { trustedBy: { userId: 'local', ts: 1 } }),
    ).onLoad(host)
    expect(register).toHaveBeenCalledTimes(1)
    const specArg = register.mock.calls[0][0]
    expect(specArg.name).toBe(`${GENERATED_B_TOOL_PREFIX}my_tool`)
    expect(specArg.approvalMode).toBe('always')
    // 真 handler 是 function（runBHandler 包装），这里不执行避免依赖 executeTool
    expect(typeof specArg.handler).toBe('function')
  })

  it('非法 spec（handlerSource 空）→ 不注册 + emit failed', async () => {
    const { host, register } = makeHost()
    const got: Array<{ status?: string; reason?: string }> = []
    pluginEvents.on('plugin.registered', (p) => got.push(p))
    await new GeneratedBPlugin(
      makeManifest({ ...validSpec, handlerSource: '' }, { trustedBy: null }),
    ).onLoad(host)
    expect(register).not.toHaveBeenCalled()
    expect(got[0]?.status).toBe('failed')
    expect(got[0]?.reason).toBe('handler_source_empty')
  })

  it('非法 spec（编译失败）→ 不注册 + emit compile_failed', async () => {
    const { host, register } = makeHost()
    const got: Array<{ status?: string; reason?: string }> = []
    pluginEvents.on('plugin.registered', (p) => got.push(p))
    await new GeneratedBPlugin(
      makeManifest({ ...validSpec, handlerSource: 'const = ;' }, { trustedBy: null }),
    ).onLoad(host)
    expect(register).not.toHaveBeenCalled()
    expect(got[0]?.reason).toBe('compile_failed')
  })

  it('合法 → emit plugin.registered status=ok', async () => {
    const { host } = makeHost()
    const got: Array<{ status?: string }> = []
    pluginEvents.on('plugin.registered', (p) => got.push(p))
    await new GeneratedBPlugin(makeManifest(validSpec, { trustedBy: null })).onLoad(host)
    expect(got[0]?.status).toBe('ok')
  })
})

describe('GeneratedBPlugin.onLoad（configSchema 注入 + 注册点校验）', () => {
  beforeEach(() => pluginEvents.clear())

  const configSpec: GeneratedBSpec = {
    name: 'cfg_tool',
    description: 'with config',
    inputSchema: { type: 'object' },
    handlerSource: 'return JSON.stringify(ctx.config)',
  }

  it('已信任 + configSchema → ctx.config 注入 handler（secret 走 vault 明文）', async () => {
    const { host, register } = makeHost({
      secrets: { get: async (k) => (k === 'k1' ? 'PLAIN1' : null) },
    })
    const schema: PluginConfigField[] = [
      { name: 'base', type: 'string', default: 'https://b' },
      { name: 'tok', type: 'string', secret: true, vaultKeyId: 'k1' },
    ]
    await new GeneratedBPlugin(
      makeManifest(configSpec, { trustedBy: { userId: 'local', ts: 1 }, configSchema: schema }),
    ).onLoad(host)
    expect(register).toHaveBeenCalledTimes(1)
    const specArg = register.mock.calls[0][0]
    expect(specArg.approvalMode).toBe('always')
    const handler = specArg.handler as (a: unknown, c: unknown) => Promise<{ content: string }>
    const out = await handler({}, {})
    expect(JSON.parse(out.content)).toEqual({ base: 'https://b', tok: 'PLAIN1' })
  })

  it('非法 configSchema（字段 name 空）→ 不注册 + emit failed（config_field_name）', async () => {
    const { host, register } = makeHost()
    const got: Array<{ status?: string; reason?: string }> = []
    pluginEvents.on('plugin.registered', (p) => got.push(p))
    const badSchema: PluginConfigField[] = [{ name: '', type: 'string' }]
    await new GeneratedBPlugin(
      makeManifest(validSpec, { trustedBy: { userId: 'local', ts: 1 }, configSchema: badSchema }),
    ).onLoad(host)
    expect(register).not.toHaveBeenCalled()
    expect(got[0]?.status).toBe('failed')
    expect(got[0]?.reason).toBe('config_field_name')
  })

  it('secret 缺 vaultKeyId → 不注册 + emit failed（config_secret_key）', async () => {
    const { host, register } = makeHost()
    const got: Array<{ status?: string; reason?: string }> = []
    pluginEvents.on('plugin.registered', (p) => got.push(p))
    const badSchema: PluginConfigField[] = [{ name: 'tok', type: 'string', secret: true }]
    await new GeneratedBPlugin(
      makeManifest(validSpec, { trustedBy: { userId: 'local', ts: 1 }, configSchema: badSchema }),
    ).onLoad(host)
    expect(register).not.toHaveBeenCalled()
    expect(got[0]?.status).toBe('failed')
    expect(got[0]?.reason).toBe('config_secret_key')
  })
})

describe('saveGeneratedBPlugin 工具名冲突检查', () => {
  it('同名不同 id → 抛 tool_name_conflict（IpcErrorThrow 带 messageKey）', () => {
    saveGeneratedBPlugin({ spec: { ...validSpec, name: 'conflict_tool' } })
    try {
      saveGeneratedBPlugin({ spec: { ...validSpec, name: 'conflict_tool' } })
      expect.unreachable('应抛冲突')
    } catch (e) {
      expect(e).toBeInstanceOf(IpcErrorThrow)
      expect((e as IpcErrorThrow).messageKey).toBe('errors:plugins.tool_name_conflict')
    }
  })

  it('同 id 覆盖保存（更新自身）→ 不抛', () => {
    const f = saveGeneratedBPlugin({ spec: { ...validSpec, name: 'self_update_tool' } })
    expect(() =>
      saveGeneratedBPlugin({ id: f.id, spec: { ...validSpec, name: 'self_update_tool' } }),
    ).not.toThrow()
  })
})

describe('setBPluginTrusted（enabled 闸门：disabled 只落盘不动 registry）', () => {
  it('disabled 插件信任 → 只落盘 trustedBy，不注册工具', async () => {
    const file = saveGeneratedBPlugin({
      spec: { ...validSpec, name: 'disabled_trust_tool' },
      enabled: false,
    })
    const { host, register } = makeHost()
    await setBPluginTrusted(host, file.id, { userId: 'local', ts: 1 })
    expect(register).not.toHaveBeenCalled()
    expect(loadGeneratedBPluginManifest(file.id)?.trustedBy).not.toBeNull()
  })

  it('disabled 插件取消信任 → 不触发 enable（enabled 保持 false）', async () => {
    const file = saveGeneratedBPlugin({
      spec: { ...validSpec, name: 'disabled_untrust_tool' },
      enabled: false,
      trustedBy: { userId: 'local', ts: 1 },
    })
    const { host, register } = makeHost()
    await setBPluginTrusted(host, file.id, null)
    expect(register).not.toHaveBeenCalled()
    const m = loadGeneratedBPluginManifest(file.id)
    expect(m?.trustedBy).toBeNull()
    expect(m?.enabled).toBe(false)
  })

  it('enabled 插件信任 → 重载注册真 handler（always）', async () => {
    const file = saveGeneratedBPlugin({
      spec: { ...validSpec, name: 'enabled_trust_tool' },
      enabled: true,
    })
    const { host, register } = makeHost()
    await setBPluginTrusted(host, file.id, { userId: 'local', ts: 1 })
    expect(register).toHaveBeenCalledTimes(1)
    expect(register.mock.calls[0][0].approvalMode).toBe('always')
  })

  it('enabled 插件取消信任 → 重载回占位（auto + trusted_required）', async () => {
    const file = saveGeneratedBPlugin({
      spec: { ...validSpec, name: 'enabled_untrust_tool' },
      enabled: true,
      trustedBy: { userId: 'local', ts: 1 },
    })
    const { host, register } = makeHost()
    await setBPluginTrusted(host, file.id, null)
    expect(register).toHaveBeenCalledTimes(1)
    const specArg = register.mock.calls[0][0]
    expect(specArg.approvalMode).toBe('auto')
    const handler = specArg.handler as (
      a: unknown,
      c: unknown,
    ) => Promise<{ isError: boolean; content: string }>
    const out = await handler({}, {})
    expect(out.content).toContain('trusted_required')
  })

  it('不存在的 id → 抛 not found', async () => {
    const { host } = makeHost()
    await expect(
      setBPluginTrusted(host, 'genb_nonexistent', { userId: 'local', ts: 1 }),
    ).rejects.toThrow(/not found/)
  })
})
