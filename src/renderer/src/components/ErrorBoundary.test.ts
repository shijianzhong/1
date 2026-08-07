import { describe, expect, it, vi } from 'vitest'

// mock i18n（node 环境无 window，startupMark 依赖 window.__ONE_STARTUP__）
vi.mock('@renderer/i18n', () => ({
  default: { t: (key: string) => key },
}))

import { ErrorBoundary } from './ErrorBoundary'

// —— ErrorBoundary 纯逻辑测试（getDerivedStateFromError 静态方法）——
// render() 依赖 DOM + i18n，不在 node 环境测；getDerivedStateFromError 是纯函数可直测。

describe('ErrorBoundary.getDerivedStateFromError', () => {
  it('Error 实例 → 提取 message', () => {
    const state = ErrorBoundary.getDerivedStateFromError(new Error('boom'))
    expect(state.hasError).toBe(true)
    expect(state.message).toBe('boom')
  })

  it('Error 子类 → 提取 message', () => {
    class CustomError extends Error {
      constructor(msg: string) {
        super(msg)
        this.name = 'CustomError'
      }
    }
    const state = ErrorBoundary.getDerivedStateFromError(new CustomError('custom fail'))
    expect(state.hasError).toBe(true)
    expect(state.message).toBe('custom fail')
  })

  it('非 Error 值 → String() 转换', () => {
    const state = ErrorBoundary.getDerivedStateFromError('string error')
    expect(state.hasError).toBe(true)
    expect(state.message).toBe('string error')
  })

  it('null → String(null) = "null"', () => {
    const state = ErrorBoundary.getDerivedStateFromError(null)
    expect(state.hasError).toBe(true)
    expect(state.message).toBe('null')
  })

  it('数字 → String(42) = "42"', () => {
    const state = ErrorBoundary.getDerivedStateFromError(42)
    expect(state.hasError).toBe(true)
    expect(state.message).toBe('42')
  })

  it('空 Error → message 为空字符串', () => {
    const state = ErrorBoundary.getDerivedStateFromError(new Error(''))
    expect(state.hasError).toBe(true)
    expect(state.message).toBe('')
  })
})
