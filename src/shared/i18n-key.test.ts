import { describe, expect, it } from 'vitest'
import { normalizeI18nKey, IpcErrorThrow } from './types'

describe('normalizeI18nKey', () => {
  it('errors.foo.bar → errors:foo.bar', () => {
    expect(normalizeI18nKey('errors.home.no_provider')).toBe('errors:home.no_provider')
    expect(normalizeI18nKey('errors.tools.shell_timeout')).toBe('errors:tools.shell_timeout')
  })

  it('已是冒号形态则原样返回', () => {
    expect(normalizeI18nKey('errors:home.no_provider')).toBe('errors:home.no_provider')
    expect(normalizeI18nKey('home:create.recovery.pending')).toBe('home:create.recovery.pending')
  })

  it('IpcErrorThrow 构造时归一化 messageKey', () => {
    const e = new IpcErrorThrow('errors.home.no_provider', '未配置供应商')
    expect(e.messageKey).toBe('errors:home.no_provider')
    expect(e.message).toBe('未配置供应商')
  })
})
