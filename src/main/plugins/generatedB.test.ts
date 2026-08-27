import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  GeneratedBPlugin,
  GENERATED_B_TOOL_PREFIX,
  type GeneratedBPluginManifest,
} from './generatedB'
import { validateGeneratedBSpec } from './whitelist'
import { pluginEvents } from './events'
import type { PluginHost, PluginToolSpec, PluginHandle } from './contracts'
import type { GeneratedBSpec, PluginConfigField } from '@shared/types'

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
