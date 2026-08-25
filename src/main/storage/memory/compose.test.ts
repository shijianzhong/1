import { describe, expect, it } from 'vitest'
import type { Persona } from '@shared/types'
import { withOrchestrationMemory } from './compose'

const persona: Persona = {
  id: 'home',
  name: '助手',
  instructions: '',
  profile: { alias: '小明', role: '工程师', preferredLanguage: 'zh-CN' },
  updatedAt: 0,
}

describe('withOrchestrationMemory（编排路径记忆基座）', () => {
  it('无 persona / 无 L2 → 原样返回 base', () => {
    expect(withOrchestrationMemory('角色指令', null, '')).toBe('角色指令')
  })

  it('仅 L2 → 接在 base 末尾', () => {
    expect(
      withOrchestrationMemory('角色指令', null, '【该用户历史对话摘要】\n- 摘要A'),
    ).toBe('角色指令\n\n【该用户历史对话摘要】\n- 摘要A')
  })

  it('仅 persona → 身份块拼到开头', () => {
    expect(withOrchestrationMemory('角色指令', persona, '')).toBe(
      '【用户档案】\n称呼：小明\n角色：工程师\n偏好回复语种：中文\n\n角色指令',
    )
  })

  it('persona + L2 → 身份块开头、L2 接末尾', () => {
    expect(
      withOrchestrationMemory('角色指令', persona, '【该用户历史对话摘要】\n- 摘要A'),
    ).toBe(
      '【用户档案】\n称呼：小明\n角色：工程师\n偏好回复语种：中文\n\n角色指令\n\n【该用户历史对话摘要】\n- 摘要A',
    )
  })
})
