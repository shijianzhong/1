import { describe, it, expect } from 'vitest'
import { validateGeneratedSpec } from './whitelist'

const baseSchema = { type: 'object' as const }

describe('validateGeneratedSpec（generated/A 注册点 fail-closed 闸门）', () => {
  it('通过：白名单动作 + 合法 subset 参数', () => {
    const r = validateGeneratedSpec({
      inputSchema: baseSchema,
      executeAction: { action: 'file_read', params: { path: '/x' } },
    })
    expect(r.ok).toBe(true)
  })

  it('通过：可选参数省略、bounds 内', () => {
    const r = validateGeneratedSpec({
      inputSchema: baseSchema,
      executeAction: { action: 'file_search', params: { query: 'q', maxResults: 50 } },
    })
    expect(r.ok).toBe(true)
  })

  it('允许：inputSchema 省略（LLM 可见 schema 可选）', () => {
    const r = validateGeneratedSpec({
      executeAction: { action: 'file_read', params: { path: '/x' } },
    })
    expect(r.ok).toBe(true)
  })

  it('拒绝：action 不在白名单', () => {
    const r = validateGeneratedSpec({
      inputSchema: baseSchema,
      executeAction: { action: 'rm_rf', params: {} },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('action_not_whitelisted')
  })

  it('拒绝：声明了白名单没有的参数（superset）', () => {
    const r = validateGeneratedSpec({
      inputSchema: baseSchema,
      executeAction: { action: 'file_read', params: { path: '/x', evil: 1 } },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('params_not_subset')
  })

  it('拒绝：参数类型不兼容', () => {
    const r = validateGeneratedSpec({
      inputSchema: baseSchema,
      executeAction: { action: 'file_read', params: { path: 123 } },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('param_type_mismatch')
  })

  it('拒绝：数值 bounds 超出白名单上界', () => {
    const r = validateGeneratedSpec({
      inputSchema: baseSchema,
      executeAction: { action: 'file_search', params: { query: 'q', maxResults: 999 } },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('param_bound_too_wide')
  })

  it('拒绝：缺失必填参数', () => {
    const r = validateGeneratedSpec({
      inputSchema: baseSchema,
      executeAction: { action: 'file_read', params: {} },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('required_missing')
  })

  it('拒绝：inputSchema 非 object', () => {
    const r = validateGeneratedSpec({
      inputSchema: { type: 'string' },
      executeAction: { action: 'file_read', params: { path: '/x' } },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('invalid_input_schema')
  })

  it('拒绝：数组元素类型不匹配', () => {
    const r = validateGeneratedSpec({
      inputSchema: baseSchema,
      executeAction: { action: 'kb_search', params: { query: 'q', docIds: [1, 2] } },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('param_type_mismatch')
  })
})
