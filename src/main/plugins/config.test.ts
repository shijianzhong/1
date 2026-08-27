import { describe, it, expect } from 'vitest'
import { resolvePluginConfig } from './config'
import { validatePluginConfigSchema } from './whitelist'
import type { PluginHost } from './contracts'
import type { PluginConfigField } from '@shared/types'

function makeHost(
  secrets?: { get: (k: string) => Promise<string | null> },
): PluginHost {
  return {
    tools: {
      register: () => ({ name: '', unregister: () => {} }),
      unregister: () => 0,
      list: () => [],
    },
    events: { on: () => () => {}, emit: () => {} },
    ...(secrets ? { secrets } : {}),
  } as unknown as PluginHost
}

describe('validatePluginConfigSchema（注册点 fail-closed 闸门）', () => {
  it('undefined / null → ok（配置项是可选）', () => {
    expect(validatePluginConfigSchema(undefined).ok).toBe(true)
    expect(validatePluginConfigSchema(null).ok).toBe(true)
  })

  it('合法字段数组（三种类型 + default）→ ok', () => {
    const schema: PluginConfigField[] = [
      { name: 'apiBase', type: 'string', default: 'https://x' },
      { name: 'retries', type: 'number', default: 3 },
      { name: 'verbose', type: 'boolean', default: false },
      { name: 'tok', type: 'string', secret: true, vaultKeyId: 'k1' },
    ]
    expect(validatePluginConfigSchema(schema).ok).toBe(true)
  })

  it('非数组（对象）→ invalid_config_schema + i18n key', () => {
    const r = validatePluginConfigSchema({ name: 'x' } as unknown as PluginConfigField[])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('invalid_config_schema')
      expect(r.messageKey).toBe('errors:plugins.invalid_config_schema')
    }
  })

  it('字段 name 为空 → config_field_name', () => {
    const r = validatePluginConfigSchema([{ name: '', type: 'string' }])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('config_field_name')
      expect(r.messageKey).toBe('errors:plugins.config_field_name')
    }
  })

  it('字段 type 非法 → config_field_type', () => {
    const r = validatePluginConfigSchema([
      { name: 'x', type: 'date' as unknown as PluginConfigField['type'] },
    ])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('config_field_type')
  })

  it('default 类型与 type 不符 → config_field_type', () => {
    const r = validatePluginConfigSchema([{ name: 'x', type: 'number', default: 'oops' }])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('config_field_type')
  })

  it('secret 缺 vaultKeyId → config_secret_key', () => {
    const r = validatePluginConfigSchema([{ name: 'tok', type: 'string', secret: true }])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('config_secret_key')
      expect(r.messageKey).toBe('errors:plugins.config_secret_key')
    }
  })
})

describe('resolvePluginConfig（运行时解析注入 ctx.config）', () => {
  it('undefined → ok，config={}', async () => {
    const r = await resolvePluginConfig(makeHost(), undefined)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config).toEqual({})
  })

  it('非 secret 字段注入声明的 default', async () => {
    const schema: PluginConfigField[] = [
      { name: 'base', type: 'string', default: 'https://b' },
      { name: 'n', type: 'number', default: 2 },
      { name: 'flag', type: 'boolean', default: true },
    ]
    const r = await resolvePluginConfig(makeHost(), schema)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config).toEqual({ base: 'https://b', n: 2, flag: true })
  })

  it('secret 字段经 host.secrets.get 解析明文', async () => {
    const get = (k: string) => Promise.resolve(k === 'k1' ? 'PLAIN1' : null)
    const schema: PluginConfigField[] = [
      { name: 'tok', type: 'string', secret: true, vaultKeyId: 'k1' },
    ]
    const r = await resolvePluginConfig(makeHost({ get }), schema)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config).toEqual({ tok: 'PLAIN1' })
  })

  it('host.secrets 未提供 → secret 字段解析为 null（fail-safe，不抛）', async () => {
    const schema: PluginConfigField[] = [
      { name: 'tok', type: 'string', secret: true, vaultKeyId: 'k1' },
    ]
    const r = await resolvePluginConfig(makeHost(), schema)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config).toEqual({ tok: null })
  })

  it('非法 configSchema → 复用 ValidateResult（reason + messageKey），不进入解析', async () => {
    const r = await resolvePluginConfig(makeHost(), [{ name: '', type: 'string' }])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('config_field_name')
      expect(r.messageKey).toBe('errors:plugins.config_field_name')
    }
  })
})
