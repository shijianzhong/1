import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Capability, Skill } from '@shared/types'

// —— planExport 级联收集 + allocSlug 唯一性（REGISTRY_REVIEW P3#8 升级必修）——
// 复现场景：一次导出 4 个中文名 agent + 同名 skill，旧实现同毫秒 Date.now()
// 兜底全撞 agent-xxx；新实现按 name → 本地 id 去前缀 → -kind → 序号分配且全局唯一。

const agents = new Map<string, Agent>()
const skills = new Map<string, Skill>()
const capabilities = new Map<string, Capability>()

vi.mock('../storage/models', () => ({
  getAgent: (id: string) => agents.get(id),
  getSkill: (id: string) => skills.get(id),
  getCapability: (id: string) => capabilities.get(id),
  getModel: () => undefined,
  saveAgent: vi.fn(),
  saveCapability: vi.fn(),
  saveSkill: vi.fn(),
}))

import { planExport } from './exporter'

function makeAgent(id: string, name: string, skillIds: string[] = []): Agent {
  return { id, name, instructions: 'i', skillIds, source: 'builtin', createdAt: 1, updatedAt: 2 }
}

function makeSkill(id: string, name: string): Skill {
  return { id, name, content: '# S', createdAt: 1, updatedAt: 2 }
}

function makePipeline(): Capability {
  return {
    id: 'cap_content_pipeline',
    name: '内容生产闭环',
    graph: {
      nodes: [
        { id: 'n1', type: 'agent', position: { x: 0, y: 0 }, data: { sourceAgentId: 'agt_wechat_writing', skillIds: ['skl_wechatwriting'] } },
        { id: 'n2', type: 'agent', position: { x: 0, y: 0 }, data: { sourceAgentId: 'agt_content_review', skillIds: ['skl_contentreview'] } },
        { id: 'n3', type: 'agent', position: { x: 0, y: 0 }, data: { sourceAgentId: 'agt_content_teardown', skillIds: ['skl_contentteardown'] } },
        { id: 'n4', type: 'agent', position: { x: 0, y: 0 }, data: { sourceAgentId: 'agt_tech_research', skillIds: ['skl_techresearch'] } },
      ],
      edges: [],
    },
    createdAt: 1,
    updatedAt: 2,
  }
}

function seedPipeline(): void {
  skills.set('skl_wechatwriting', makeSkill('skl_wechatwriting', 'wechat-writing'))
  skills.set('skl_contentreview', makeSkill('skl_contentreview', 'content-review'))
  skills.set('skl_contentteardown', makeSkill('skl_contentteardown', 'content-teardown'))
  skills.set('skl_techresearch', makeSkill('skl_techresearch', 'tech-research'))
  agents.set('agt_wechat_writing', makeAgent('agt_wechat_writing', '公众号写作', ['skl_wechatwriting']))
  agents.set('agt_content_review', makeAgent('agt_content_review', '内容审稿', ['skl_contentreview']))
  agents.set('agt_content_teardown', makeAgent('agt_content_teardown', '对标拆解', ['skl_contentteardown']))
  agents.set('agt_tech_research', makeAgent('agt_tech_research', '选题调研', ['skl_techresearch']))
  capabilities.set('cap_content_pipeline', makePipeline())
}

beforeEach(() => {
  agents.clear()
  skills.clear()
  capabilities.clear()
})

describe('planExport slug 分配', () => {
  it('中文名 agent + 同名 skill 同计划 → slug 唯一且有语义（用户实撞场景）', () => {
    seedPipeline()
    const { items, warnings } = planExport('capability', 'cap_content_pipeline')
    expect(warnings).toEqual([])
    expect(items).toHaveLength(9) // 1 cap + 4 agent + 4 skill

    const slugs = items.map((i) => i.slug)
    expect(new Set(slugs).size).toBe(9) // 全局唯一，无 agent-xxx 同毫秒撞车

    expect(slugs).toContain('content-pipeline') // cap_content_pipeline 去前缀
    expect(slugs).toContain('wechat-writing') // skill 英文名直接 slug
    // 同名冲突时 agent 补 -kind 后缀（skill 先占 clean slug）
    expect(slugs).toContain('wechat-writing-agent')
    expect(slugs).toContain('content-review')
    expect(slugs).toContain('content-review-agent')
    expect(slugs).toContain('tech-research')
    expect(slugs).toContain('tech-research-agent')
  })

  it('name 与 id 均无法 slug 化 → 时间戳+随机后缀且互不相同', () => {
    skills.set('skl_调研', makeSkill('skl_调研', '调研甲'))
    skills.set('skl_写作', makeSkill('skl_写作', '写作乙'))
    capabilities.set('cap_x', {
      id: 'cap_x',
      name: 'x',
      graph: {
        nodes: [
          { id: 'n1', type: 'agent', position: { x: 0, y: 0 }, data: { skillIds: ['skl_调研'] } },
          { id: 'n2', type: 'agent', position: { x: 0, y: 0 }, data: { skillIds: ['skl_写作'] } },
        ],
        edges: [],
      },
      createdAt: 1,
      updatedAt: 2,
    })
    const { items } = planExport('capability', 'cap_x')
    const skillSlugs = items.filter((i) => i.kind === 'skill').map((i) => i.slug)
    expect(skillSlugs[0]).not.toBe(skillSlugs[1])
    for (const s of skillSlugs) expect(s).toMatch(/^skill-[a-z0-9]+-[0-9a-f]{4}$/)
  })

  it('provenance 优先且占位：后续 fallback 避让 -kind 后缀', () => {
    skills.set('skl_a', {
      ...makeSkill('skl_a', 'Web Research'),
      registry: { registryId: 'web-research', version: '1.2.3', importedAt: 1754000000000 },
    })
    agents.set('agt_web_research', makeAgent('agt_web_research', '网络调研', ['skl_a']))
    const { items } = planExport('agent', 'agt_web_research')

    const skillItem = items.find((i) => i.kind === 'skill')
    expect(skillItem).toMatchObject({ slug: 'web-research', version: '1.2.4', status: 'update' })

    // 中文名 + id 去前缀也得 web-research → 已被 provenance 占位 → 避让
    const agentItem = items.find((i) => i.kind === 'agent')
    expect(agentItem?.slug).toBe('web-research-agent')
    expect(agentItem?.status).toBe('new')
  })
})
