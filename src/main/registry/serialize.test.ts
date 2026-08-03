import { describe, expect, it } from 'vitest'
import type { Agent, Capability, Skill } from '@shared/types'
import {
  buildSkillMarkdown,
  bumpPatch,
  serializeAgentManifest,
  serializeCapabilityManifest,
  serializeSkillManifest,
  slugify,
  yamlSafe,
} from './serialize'

const NOW = '2026-08-03T02:00:00.000Z'

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agt_1',
    name: 'Code Reviewer',
    instructions: 'You review code.',
    skillIds: ['skl_a', 'skl_b', 'skl_missing'],
    modelId: 'mdl_1',
    temperature: 0.3,
    maxTokens: 16384,
    outputConstraints: '≤500字',
    source: 'custom',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 'skl_1',
    name: 'Web Research',
    description: 'Deep research',
    content: '# Web Research\n\nDo research.',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

function makeCapability(overrides: Partial<Capability> = {}): Capability {
  return {
    id: 'cap_1',
    name: 'Pipeline',
    graph: {
      nodes: [
        {
          id: 'n1',
          type: 'agent',
          position: { x: 0, y: 0 },
          data: {
            label: '研究员',
            instructions: '调研',
            modelId: 'mdl_1',
            skillIds: ['skl_a', 'skl_gone'],
            sourceAgentId: 'agt_1',
          },
        },
        {
          id: 'n2',
          type: 'agent',
          position: { x: 100, y: 0 },
          data: { label: '手动节点', instructions: '无关联角色' },
        },
      ],
      edges: [{ source: 'n1', target: 'n2' }],
    },
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

describe('slugify', () => {
  it('小写化并折叠非法字符', () => {
    expect(slugify('Code Reviewer!')).toBe('code-reviewer')
    expect(slugify('  Web--Research  ')).toBe('web-research')
  })

  it('中文名无法产出合法 slug → 空串（调用方兜底）', () => {
    expect(slugify('代码审查')).toBe('')
  })
})

describe('bumpPatch', () => {
  it('semver patch +1', () => {
    expect(bumpPatch('1.0.0')).toBe('1.0.1')
    expect(bumpPatch('2.3.9')).toBe('2.3.10')
  })

  it('非 semver 原样返回', () => {
    expect(bumpPatch('v1')).toBe('v1')
  })
})

describe('serializeAgentManifest', () => {
  it('skillIds 转 slug、剥离本地字段、modelHint 转换', () => {
    const { manifest, droppedSkillIds } = serializeAgentManifest(makeAgent(), {
      slug: 'code-reviewer',
      version: '1.0.1',
      slugOfSkill: (id) => ({ skl_a: 'web-research', skl_b: 'file-analyzer' })[id],
      modelHint: 'claude-sonnet-5',
      updatedAt: NOW,
    })
    expect(manifest).toEqual({
      id: 'code-reviewer',
      name: 'Code Reviewer',
      version: '1.0.1',
      updatedAt: NOW,
      instructions: 'You review code.',
      skillIds: ['web-research', 'file-analyzer'],
      modelHint: 'claude-sonnet-5',
      temperature: 0.3,
      maxTokens: 16384,
      outputConstraints: '≤500字',
    })
    expect(manifest).not.toHaveProperty('modelId')
    expect(manifest).not.toHaveProperty('source')
    expect(droppedSkillIds).toEqual(['skl_missing'])
  })

  it('无 skillIds 时不产出该字段', () => {
    const { manifest } = serializeAgentManifest(makeAgent({ skillIds: undefined }), {
      slug: 'a',
      version: '1.0.0',
      slugOfSkill: () => undefined,
      updatedAt: NOW,
    })
    expect(manifest).not.toHaveProperty('skillIds')
  })
})

describe('buildSkillMarkdown', () => {
  it('frontmatter + content 原文', () => {
    const md = buildSkillMarkdown(makeSkill())
    expect(md).toBe(
      '---\nname: Web Research\ndescription: Deep research\n---\n\n# Web Research\n\nDo research.\n',
    )
  })

  it('content 已含 Discipline 段 → 不重复追加', () => {
    const md = buildSkillMarkdown(
      makeSkill({ content: '# S\n\n## Discipline\n\n- 输出 ≤500 字', discipline: '- 输出 ≤500 字' }),
    )
    expect(md.match(/## Discipline/g)).toHaveLength(1)
  })

  it('discipline 字段存在但 content 缺段 → 追加段落', () => {
    const md = buildSkillMarkdown(makeSkill({ discipline: '- 必须引用来源' }))
    expect(md).toContain('## Discipline\n\n- 必须引用来源')
  })

  it('name/description 含 YAML 特殊字符 → 双引号包裹（REGISTRY_REVIEW P2）', () => {
    const md = buildSkillMarkdown(
      makeSkill({ name: 'Code: Reviewer', description: '含 # 注释与 "引号"' }),
    )
    expect(md).toContain('name: "Code: Reviewer"')
    expect(md).toContain('description: "含 # 注释与 \\"引号\\""')
  })
})

describe('yamlSafe', () => {
  it('无特殊字符原样返回', () => {
    expect(yamlSafe('Web Research')).toBe('Web Research')
    expect(yamlSafe('代码审查')).toBe('代码审查')
  })

  it('冒号/井号/换行/引号/括号 → 双引号包裹并转义', () => {
    expect(yamlSafe('Code: Reviewer')).toBe('"Code: Reviewer"')
    expect(yamlSafe('a # b')).toBe('"a # b"')
    expect(yamlSafe('line1\nline2')).toBe('"line1\nline2"')
    expect(yamlSafe('say "hi"')).toBe('"say \\"hi\\""')
    expect(yamlSafe('a\\b')).toBe('a\\b') // 仅反斜杠无特殊字符不包裹
    expect(yamlSafe('[draft]')).toBe('"[draft]"')
  })
})

describe('serializeSkillManifest', () => {
  it('hasScripts/hasDiscipline 按事实置位，false 不产出字段', () => {
    const withBoth = serializeSkillManifest(makeSkill({ discipline: 'd' }), {
      slug: 'web-research',
      version: '1.0.0',
      hasScripts: true,
      updatedAt: NOW,
    })
    expect(withBoth).toMatchObject({ skillZip: 'skill.zip', hasScripts: true, hasDiscipline: true })

    const bare = serializeSkillManifest(makeSkill(), {
      slug: 'web-research',
      version: '1.0.0',
      hasScripts: false,
      updatedAt: NOW,
    })
    expect(bare).not.toHaveProperty('hasScripts')
    expect(bare).not.toHaveProperty('hasDiscipline')
  })
})

describe('serializeCapabilityManifest', () => {
  it('图节点 slug 化 + 剥离 modelId + dependencies 自动推导', () => {
    const { manifest, droppedSkillIds } = serializeCapabilityManifest(makeCapability(), {
      slug: 'pipeline',
      version: '1.0.0',
      slugOfSkill: (id) => (id === 'skl_a' ? 'web-research' : undefined),
      slugOfAgent: (id) => (id === 'agt_1' ? 'researcher' : undefined),
      updatedAt: NOW,
    })
    const n1 = manifest.graph.nodes[0].data
    expect(n1.skillIds).toEqual(['web-research'])
    expect(n1.sourceAgentId).toBe('researcher')
    expect(n1).not.toHaveProperty('modelId')
    // 手动节点（无 sourceAgentId）不产生 agent 依赖
    expect(manifest.dependencies).toEqual({ agents: ['researcher'], skills: ['web-research'] })
    expect(droppedSkillIds).toEqual(['skl_gone'])
    // 边原样保留
    expect(manifest.graph.edges).toEqual([{ source: 'n1', target: 'n2' }])
  })

  it('全部依赖缺失 → 无 dependencies 字段', () => {
    const { manifest } = serializeCapabilityManifest(makeCapability(), {
      slug: 'pipeline',
      version: '1.0.0',
      slugOfSkill: () => undefined,
      slugOfAgent: () => undefined,
      updatedAt: NOW,
    })
    expect(manifest).not.toHaveProperty('dependencies')
    expect(manifest.graph.nodes[0].data).not.toHaveProperty('skillIds')
    expect(manifest.graph.nodes[0].data).not.toHaveProperty('sourceAgentId')
  })

  it('多节点引用同一未映射依赖 → dropped 去重（REGISTRY_REVIEW P2）', () => {
    const cap = makeCapability()
    cap.graph.nodes.push({
      id: 'n3',
      type: 'agent',
      position: { x: 200, y: 0 },
      data: { label: '第二个引用节点', skillIds: ['skl_gone'], sourceAgentId: 'agt_gone' },
    })
    const { droppedSkillIds, droppedAgentIds } = serializeCapabilityManifest(cap, {
      slug: 'pipeline',
      version: '1.0.0',
      slugOfSkill: (id) => (id === 'skl_a' ? 'web-research' : undefined),
      slugOfAgent: (id) => (id === 'agt_1' ? 'researcher' : undefined),
      updatedAt: NOW,
    })
    expect(droppedSkillIds).toEqual(['skl_gone'])
    expect(droppedAgentIds).toEqual(['agt_gone'])
  })
})
