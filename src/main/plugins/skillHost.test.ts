import { describe, it, expect, vi, beforeEach } from 'vitest'

// 用 vi.hoisted 让 mock 工厂与测试体共享同一份 holder，使 listSkills / setSkillEnabled 数据一致，
// disableSkill 的 setSkillEnabled 返回值能真实驱动 disabledSkills 集合。
const { storeHolder } = vi.hoisted(() => ({
  storeHolder: { skills: [] as Array<{ id: string; enabled?: boolean }> },
}))

vi.mock('../storage/skills/store', () => ({
  listSkills: vi.fn(() => storeHolder.skills),
  setSkillEnabled: vi.fn((id: string, enabled: boolean) => {
    const s = storeHolder.skills.find((x) => x.id === id)
    if (s) {
      s.enabled = enabled
      return s
    }
    return null
  }),
  invalidateSkillsCache: vi.fn(),
}))

import { skillHostManager } from './skillHost'

describe('SkillHostManager（/plugins 启停 → beforeRun skillIds 过滤）', () => {
  beforeEach(() => {
    storeHolder.skills = [
      { id: 's1', enabled: false },
      { id: 's2', enabled: true },
    ]
    skillHostManager.refreshDisabledSet()
  })

  it('filterSkillIds 剔除 disabled 的 skill', () => {
    expect(skillHostManager.filterSkillIds(['s1', 's2', 's3'])).toEqual(['s2', 's3'])
  })

  it('无 disabled 时原样返回', () => {
    storeHolder.skills = [{ id: 's1', enabled: true }]
    skillHostManager.refreshDisabledSet()
    expect(skillHostManager.filterSkillIds(['s1'])).toEqual(['s1'])
  })

  it('enableSkill 后从 disabled 集合移除', async () => {
    await skillHostManager.enableSkill('s1')
    expect(skillHostManager.isDisabled('s1')).toBe(false)
    expect(skillHostManager.filterSkillIds(['s1'])).toEqual(['s1'])
  })

  it('disableSkill 后加入 disabled 集合', async () => {
    await skillHostManager.disableSkill('s2')
    expect(skillHostManager.isDisabled('s2')).toBe(true)
    expect(skillHostManager.filterSkillIds(['s2'])).toEqual([])
  })
})
