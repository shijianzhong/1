import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Skill } from '@shared/types'
import { clearTools, executeTool, listToolDefs } from '../registry'
import { registerSkillRagTools } from './skillRag'

vi.mock('../../storage/models', () => ({
  getSkill: vi.fn(() => null),
}))
vi.mock('../../storage/skills/fts', () => ({
  searchSkills: vi.fn(() => []),
}))
vi.mock('../../skills/provider', () => ({
  getSkillRootDir: vi.fn(() => '/mock/skill-root'),
  listSkillScripts: vi.fn(() => ['analyze.py']),
}))

import { getSkill } from '../../storage/models'
import { searchSkills } from '../../storage/skills/fts'

const getSkillMock = getSkill as unknown as ReturnType<typeof vi.fn>
const searchSkillsMock = searchSkills as unknown as ReturnType<typeof vi.fn>

function skillWithScript(): Skill {
  return {
    id: 'skl_1',
    name: '行业调研',
    description: '做竞品与行业分析',
    content: '# 行业调研\n先收集资料',
    discipline: '必须给出来源',
    hasScripts: true,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('tools/builtin/skillRag', () => {
  beforeEach(() => {
    clearTools()
    registerSkillRagTools()
    getSkillMock.mockReset()
    searchSkillsMock.mockReset()
  })

  it('注册两个工具', () => {
    expect(listToolDefs().map((t) => t.name)).toEqual(expect.arrayContaining(['skill_search', 'load_skill']))
  })

  it('skill_search 透传关键词与 limit', async () => {
    searchSkillsMock.mockReturnValue([{ id: 'skl_1', name: '行业调研', desc: '做竞品与行业分析' }])
    const r = await executeTool('skill_search', { keywords: '竞品分析', limit: 3 }, 'tu_1', {})
    expect(searchSkillsMock).toHaveBeenCalledWith('竞品分析', 3)
    expect(JSON.parse(r.content)[0].id).toBe('skl_1')
  })

  it('load_skill 返回完整说明与脚本清单', async () => {
    getSkillMock.mockReturnValue(skillWithScript())
    const r = await executeTool('load_skill', { id: 'skl_1' }, 'tu_2', {})
    const data = JSON.parse(r.content)
    expect(data.id).toBe('skl_1')
    expect(data.name).toBe('行业调研')
    expect(data.content).toContain('行业调研')
    expect(data.discipline).toContain('来源')
    expect(data.scripts).toContain('analyze.py')
  })

  it('load_skill 不存在时返回结构化错误', async () => {
    getSkillMock.mockReturnValue(null)
    const r = await executeTool('load_skill', { id: 'missing' }, 'tu_3', {})
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(false)
    expect(data.error).toBe('skill_not_found')
    expect(data.messageKey).toBe('errors.tools.skill_not_found')
  })
})
