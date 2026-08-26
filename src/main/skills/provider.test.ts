import { describe, expect, it, vi } from 'vitest'
import type { Skill } from '@shared/types'
import {
  SkillContextProvider,
  buildDisciplineBlock,
  buildSkillXmlBlock,
} from './provider'
import type { PluginHost } from '../plugins/contracts'

// 最小 mock PluginHost：events 记录 emit，tools 用 vi.fn 占位（本测试不验证 tools）
function mockHost(): PluginHost & { emitted: Array<{ type: string; payload: unknown }> } {
  const emitted: Array<{ type: string; payload: unknown }> = []
  return {
    emitted,
    tools: { register: vi.fn(), unregister: vi.fn(), list: vi.fn() },
    events: {
      on: vi.fn(() => () => {}),
      emit: vi.fn((type: string, payload: unknown) => {
        emitted.push({ type, payload })
      }),
    },
  }
}

// —— SkillContextProvider 单测（铁律22，task 7.4）——
// 注入格式与旧 buildSkillBlocks 契约一致（<skill name> + description + 24000 截断），
// 新增 discipline 输出纪律段与脚本清单行。

function skill(id: string, name: string, content: string, extra?: Partial<Skill>): Skill {
  return { id, name, content, createdAt: 0, updatedAt: 0, ...extra }
}

describe('buildSkillXmlBlock', () => {
  it('inline 成 <skill> XML 块，含 description', () => {
    const out = buildSkillXmlBlock(skill('s1', '品牌规范', '# 内容', { description: '品牌写作规范' }))
    expect(out).toContain('<skill name="品牌规范"')
    expect(out).toContain('description: 品牌写作规范')
    expect(out).toContain('# 内容')
    expect(out).toContain('</skill>')
  })

  it('超 24000 字截断', () => {
    const long = 'x'.repeat(25000)
    const out = buildSkillXmlBlock(skill('s1', '长skill', long))
    expect(out).toContain('超长截断')
    expect(out.length).toBeLessThan(long.length)
  })

  it('无 description → 不带 desc 行', () => {
    const out = buildSkillXmlBlock(skill('s1', '规范', '内容'))
    expect(out).not.toContain('description:')
  })

  it('带脚本清单 → scripts 行指引 skill_run_script', () => {
    const out = buildSkillXmlBlock(skill('s1', '调研', '内容'), ['analyze.py', 'lib/util.sh'])
    expect(out).toContain('scripts: analyze.py, lib/util.sh')
    expect(out).toContain('skill_run_script')
    expect(out).toContain('skill 填 "调研"')
  })
})

describe('buildDisciplineBlock', () => {
  it('有 discipline → 输出纪律段', () => {
    const out = buildDisciplineBlock(skill('s1', '品牌规范', '内容', { discipline: '禁止夸大宣传' }))
    expect(out).toContain('【输出纪律】（技能「品牌规范」）')
    expect(out).toContain('禁止夸大宣传')
  })

  it('无/空 discipline → null', () => {
    expect(buildDisciplineBlock(skill('s1', 'a', '内容'))).toBeNull()
    expect(buildDisciplineBlock(skill('s1', 'a', '内容', { discipline: '  ' }))).toBeNull()
  })
})

describe('SkillContextProvider.beforeRun', () => {
  const skills = new Map<string, Skill>([
    ['s1', skill('s1', '品牌规范', '# 品牌内容', { description: '写作规范', discipline: '≤200字' })],
    ['s2', skill('s2', '翻译助手', '# 翻译内容')],
  ])
  const provider = (host: PluginHost = mockHost()): SkillContextProvider =>
    new SkillContextProvider((id) => skills.get(id), host)

  it('组合顺序：基础 instructions → <skill> 块 → 【输出纪律】段', () => {
    const { instructions } = provider().beforeRun({
      agentName: 'a1',
      skillIds: ['s1', 's2'],
      instructions: 'BASE',
    })
    const baseIdx = instructions.indexOf('BASE')
    const skillIdx = instructions.indexOf('<skill name="品牌规范"')
    const skill2Idx = instructions.indexOf('<skill name="翻译助手"')
    const disciplineIdx = instructions.indexOf('【输出纪律】')
    expect(baseIdx).toBeGreaterThanOrEqual(0)
    expect(skillIdx).toBeGreaterThan(baseIdx)
    expect(skill2Idx).toBeGreaterThan(skillIdx)
    expect(disciplineIdx).toBeGreaterThan(skill2Idx)
    expect(instructions).toContain('≤200字')
  })

  it('缺失 skill 跳过不阻断；injected 摘要只含命中项', () => {
    const { instructions, injected } = provider().beforeRun({
      agentName: 'a1',
      skillIds: ['missing', 's2'],
      instructions: 'BASE',
    })
    expect(instructions).not.toContain('missing')
    expect(instructions).toContain('翻译助手')
    expect(injected.length).toBe(1)
    expect(injected[0]).toMatchObject({ id: 's2', hasScripts: false, hasDiscipline: false })
  })

  it('无绑定 → instructions 原样', () => {
    const { instructions } = provider().beforeRun({ agentName: 'a1', skillIds: [], instructions: 'BASE' })
    expect(instructions).toBe('BASE')
  })

  it('afterRun 不抛（含未注入场景）', () => {
    const p = provider()
    expect(() => p.afterRun()).not.toThrow()
    p.beforeRun({ agentName: 'a1', skillIds: ['s1'], instructions: 'BASE' })
    expect(() => p.afterRun()).not.toThrow()
  })

  it('构造注入的 host：afterRun 经 this.host.events 发射 skill.injected（含 agentName 与命中 skill id）', () => {
    const host = mockHost()
    const p = provider(host)
    p.beforeRun({ agentName: 'a1', skillIds: ['s1', 's2'], instructions: 'BASE' })
    p.afterRun()
    const ev = host.emitted.find((e) => e.type === 'skill.injected')
    expect(ev).toBeDefined()
    expect(ev?.payload).toMatchObject({ agentName: 'a1', skills: ['s1', 's2'] })
  })

  it('空注入 beforeRun 后 afterRun 不发射 skill.injected（early return）', () => {
    const host = mockHost()
    const p = provider(host)
    p.beforeRun({ agentName: 'a1', skillIds: [], instructions: 'BASE' })
    p.afterRun()
    expect(host.emitted.find((e) => e.type === 'skill.injected')).toBeUndefined()
  })
})
