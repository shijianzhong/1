import { describe, expect, it } from 'vitest'
import { buildUserIdentityBlock, injectL0 } from './l0'
import type { Persona } from '@shared/types'

// —— L0 身份块单测（§三之三 D + 铁律21）——
// 纯函数，不依赖 SQLite，vitest 可测。L1/L2/L3 走 E2E（native ABI）。

describe('L0 身份块', () => {
  it('无 profile 返回空串', () => {
    expect(buildUserIdentityBlock(null)).toBe('')
    expect(
      buildUserIdentityBlock({ id: 'home', name: 'x', instructions: '', updatedAt: 0 }),
    ).toBe('')
  })

  it('有 alias/role/language 拼身份段', () => {
    const persona: Persona = {
      id: 'home',
      name: '主助手',
      instructions: '你是助手',
      profile: { alias: '老张', role: '产品经理', preferredLanguage: 'zh-CN' },
      updatedAt: 0,
    }
    const block = buildUserIdentityBlock(persona)
    expect(block).toContain('称呼：老张')
    expect(block).toContain('角色：产品经理')
    expect(block).toContain('偏好回复语种：中文')
    expect(block.startsWith('【用户档案】')).toBe(true)
  })

  it('部分字段缺失只拼有的', () => {
    const persona: Persona = {
      id: 'home',
      name: 'x',
      instructions: '',
      profile: { alias: '小李' },
      updatedAt: 0,
    }
    const block = buildUserIdentityBlock(persona)
    expect(block).toContain('称呼：小李')
    expect(block).not.toContain('角色')
  })

  it('injectL0 把身份块拼到 instructions 开头', () => {
    const persona: Persona = {
      id: 'home',
      name: 'x',
      instructions: '你是主助手',
      profile: { alias: '老王' },
      updatedAt: 0,
    }
    const out = injectL0('你是主助手', persona)
    expect(out.startsWith('【用户档案】')).toBe(true)
    expect(out).toContain('称呼：老王')
    expect(out).toContain('你是主助手')
    // 身份块在前
    expect(out.indexOf('称呼：老王')).toBeLessThan(out.indexOf('你是主助手'))
  })

  it('无档案时 injectL0 原样返回 instructions', () => {
    expect(injectL0('你是助手', null)).toBe('你是助手')
  })
})
