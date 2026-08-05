import { describe, it, expect, vi } from 'vitest'
import type { McpServerConfig } from '@shared/types'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/one-mcp-config-test' },
}))

vi.mock('../../secrets/vault', () => ({
  setKey: vi.fn(),
  getKey: vi.fn((id: string) =>
    id.startsWith('mcp:srv-1:') ? 'secret-value' : null,
  ),
  removeKey: vi.fn(),
  isVaultAvailable: vi.fn(() => true),
}))

import { sanitizeConfig, resolveSecrets } from './config'

describe('mcp/config sanitize + resolve (R3)', () => {
  const base: McpServerConfig = {
    id: 'srv-1',
    name: 'S',
    transport: 'stdio',
    command: 'npx',
    enabled: true,
    exposeToAgents: false,
    env: { API_KEY: 'vault:mcp:srv-1:env:API_KEY', PATH: '/usr/bin' },
    headers: { Authorization: 'vault:mcp:srv-1:header:Authorization' },
  }

  it('sanitizeConfig 脱敏 env/headers 值，保留键名', () => {
    const out = sanitizeConfig(base)
    expect(out.env?.API_KEY).toBe('••••••••')
    expect(out.env?.PATH).toBe('••••••••')
    expect(out.headers?.Authorization).toBe('••••••••')
    expect(out.name).toBe('S')
    expect(out.exposeToAgents).toBe(false)
    // 不修改原对象
    expect(base.env?.API_KEY).toBe('vault:mcp:srv-1:env:API_KEY')
  })

  it('resolveSecrets 将 vault: 引用还原为明文', () => {
    const out = resolveSecrets(base)
    expect(out.env?.API_KEY).toBe('secret-value')
    expect(out.headers?.Authorization).toBe('secret-value')
    // 非 vault 引用原样保留
    expect(out.env?.PATH).toBe('/usr/bin')
  })
})
