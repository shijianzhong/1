import { describe, expect, it } from 'vitest'
import type { Agent, Capability, Skill } from '@shared/types'
import {
  TeamJsonDetector,
  buildCreateInstruction,
  buildMemoryInstruction,
  buildRoutingInstruction,
  buildCapabilityFocusBlock,
  resolveMentions,
} from './home'

// —— 首页意图路由单测（§三之三 M + 铁律24）——

function agent(id: string, name: string, description?: string): Agent {
  return {
    id,
    name,
    description,
    instructions: '',
    createdAt: 0,
    updatedAt: 0,
  }
}

function capability(id: string, name: string, description?: string): Capability {
  return {
    id,
    name,
    description,
    graph: { nodes: [], edges: [] },
    createdAt: 0,
    updatedAt: 0,
  }
}

function skill(id: string, name: string, content: string, description?: string): Skill {
  return { id, name, description, content, createdAt: 0, updatedAt: 0 }
}

describe('buildRoutingInstruction', () => {
  it('无角色无能力 → 空串（不打扰人设）', () => {
    expect(buildRoutingInstruction([], [])).toBe('')
  })

  it('含角色/能力清单 + 组队 JSON 约定', () => {
    const out = buildRoutingInstruction(
      [agent('a1', '文案专家', '擅长写文案')],
      [capability('c1', '代码审查', '审查代码质量')],
    )
    expect(out).toContain('文案专家（id=a1）')
    expect(out).toContain('代码审查（id=c1）')
    expect(out).toContain('{"role_ids":')
    expect(out).toContain('{"capability_ids":')
    expect(out).toContain('独占全文')
  })

  it('只有角色 → 不含能力段', () => {
    const out = buildRoutingInstruction([agent('a1', '文案专家')], [])
    expect(out).toContain('【可用角色】')
    expect(out).not.toContain('【可用能力】')
  })
})

describe('resolveMentions', () => {
  const agents = [agent('a1', '文案专家'), agent('a2', '代码助手')]
  const caps = [capability('c1', '代码审查')]

  it('@角色名 精确命中，剥提及后留纯文本', () => {
    const r = resolveMentions('@文案专家 帮我写个标语', agents, caps)
    expect(r.agents.map((a) => a.id)).toEqual(['a1'])
    expect(r.capabilities).toEqual([])
    expect(r.cleanText).toBe('帮我写个标语')
  })

  it('@能力名 精确命中', () => {
    const r = resolveMentions('@代码审查 看下这段', agents, caps)
    expect(r.capabilities.map((c) => c.id)).toEqual(['c1'])
    expect(r.agents).toEqual([])
  })

  it('多 @角色 全命中（组队）', () => {
    const r = resolveMentions('@文案专家 @代码助手 一起评审', agents, caps)
    expect(r.agents.length).toBe(2)
    expect(r.cleanText).toBe('一起评审')
  })

  it('大小写不敏感（中文名按原样，英文按小写）', () => {
    const en = [agent('a3', 'Coder')]
    const r = resolveMentions('@coder 帮忙', en, [])
    expect(r.agents.map((a) => a.id)).toEqual(['a3'])
  })

  it('未命中名字保留原文（不误判邮箱/普通@）', () => {
    const r = resolveMentions('联系 admin@example.com 或 @不存在的人', agents, caps)
    expect(r.agents).toEqual([])
    expect(r.capabilities).toEqual([])
  })

  it('芯片序列化形态（@名字 + 空格 + 问题）命中且 cleanText 正确', () => {
    // 前端芯片序列化产出：@文案专家 帮我写个标语（@ 后是芯片名，空格分隔）
    const r = resolveMentions('@文案专家 帮我写个标语', agents, caps)
    expect(r.agents.length).toBe(1)
    expect(r.cleanText).toBe('帮我写个标语')
  })

  it('@技能名 命中 → skills 数组（注入语义，不跑编排）', () => {
    const sks = [skill('s1', '品牌文案规范', '# 规范内容')]
    const r = resolveMentions('@品牌文案规范 帮我写标语', agents, caps, sks)
    expect(r.skills.map((s) => s.id)).toEqual(['s1'])
    expect(r.agents).toEqual([])
    expect(r.capabilities).toEqual([])
    expect(r.cleanText).toBe('帮我写标语')
  })

  it('同名冲突：角色 > 能力 > 技能', () => {
    const r = resolveMentions(
      '@助手 问题',
      [agent('a1', '助手')],
      [capability('c1', '助手')],
      [skill('s1', '助手', 'x')],
    )
    expect(r.agents.map((a) => a.id)).toEqual(['a1']) // 角色优先
    expect(r.capabilities).toEqual([])
    expect(r.skills).toEqual([])
  })

  it('能力优先于技能（无同名角色时）', () => {
    const r = resolveMentions(
      '@助手 问题',
      [],
      [capability('c1', '助手')],
      [skill('s1', '助手', 'x')],
    )
    expect(r.capabilities.map((c) => c.id)).toEqual(['c1'])
    expect(r.skills).toEqual([])
  })

  it('@角色 + @技能 混合：都命中，cleanText 同时剥掉两类提及', () => {
    const sks = [skill('s1', '品牌文案规范', 'x')]
    const r = resolveMentions('@文案专家 @品牌文案规范 写标语', agents, caps, sks)
    expect(r.agents.length).toBe(1)
    expect(r.skills.length).toBe(1)
    expect(r.cleanText).toBe('写标语')
  })
})

// skill <skill> XML 注入测试已迁至 skills/provider.test.ts（task 7.4）

describe('TeamJsonDetector（铁律24）', () => {
  it('直答文本原样流出', () => {
    const det = new TeamJsonDetector()
    let out = ''
    out += det.feed('这是')
    out += det.feed('一段直答')
    out += det.feed('。')
    out += det.flushDirect()
    expect(out).toBe('这是一段直答。')
    expect(det.decide().kind).toBe('direct')
  })

  it('组队 JSON 以 {"role_ids": 开头 → 判 team，preamble 归直答缓冲', () => {
    const det = new TeamJsonDetector()
    det.feed('{"role_ids": ["a1","a2"]}')
    const d = det.decide()
    expect(d.kind).toBe('team')
    if (d.kind === 'team') {
      expect(d.json.role_ids).toEqual(['a1', 'a2'])
    }
  })

  it('跨 chunk 截断的前缀（{"role_ 在上一 chunk 末尾）→ 尾窗扣住不直推', () => {
    const det = new TeamJsonDetector()
    // 第一个 chunk 尾部是前缀前半段：不应立刻推给前端
    const safe1 = det.feed('一些文字 {"role_')
    // 安全部分不含尾窗里的 '{"role_'
    expect(safe1).not.toContain('{"role_')
    const d2 = det.feed('ids": ["a1"]}')
    expect(d2).toBe('')
    expect(det.decide().kind).toBe('team')
  })

  it('body{...} / ()=>{} 等非组队 { 不误判', () => {
    const det = new TeamJsonDetector()
    det.feed('CSS 里 body{color:red} 和 ()=>{} 都不是组队')
    expect(det.decide().kind).toBe('direct')
  })

  it('组队 JSON 后追加解释文本 → 抽平衡块解析', () => {
    const det = new TeamJsonDetector()
    det.feed('{"capability_ids": ["c1"]} 这是额外解释')
    const d = det.decide()
    expect(d.kind).toBe('team')
    if (d.kind === 'team') {
      expect(d.json.capability_ids).toEqual(['c1'])
    }
  })

  it('非法组队 JSON → 回退直答', () => {
    const det = new TeamJsonDetector()
    det.feed('{"role_ids": 这是坏的')
    expect(det.decide().kind).toBe('direct')
  })

  it('空 role_ids + 空 capability_ids → 回退直答', () => {
    const det = new TeamJsonDetector()
    det.feed('{"role_ids": []}')
    expect(det.decide().kind).toBe('direct')
  })
})

describe('buildCreateInstruction', () => {
  const persona = {
    id: 'home',
    name: '主助手',
    instructions: '你是用户的智能助手，风格简洁。',
    createdAt: 0,
    updatedAt: 0,
  }

  it('包含四类创建/修改入口 + propose 工具约定 + 确认才入库提示', () => {
    const s = buildCreateInstruction(persona)
    expect(s).toContain('propose_agent')
    expect(s).toContain('propose_capability')
    expect(s).toContain('propose_skill')
    expect(s).toContain('propose_persona')
    expect(s).toContain('确认')
    expect(s).toContain('编排图')
    // 引导先澄清再产出（避免一次就调工具）
    expect(s).toContain('先澄清')
    // 人设修改引导：全量替换 + 基于原文
    expect(s).toContain('全量替换')
    expect(s).toContain('人设修改')
    // 称呼/角色/语种修改也走 propose_persona，instructions 不传
    expect(s).toContain('叫我XX')
    expect(s).toContain('用户档案')
    expect(s).toContain('instructions 不传')
  })

  it('注入当前人设原文（<persona> 边界标记，防注入段污染固化）', () => {
    const s = buildCreateInstruction(persona)
    expect(s).toContain('<persona>')
    expect(s).toContain('你是用户的智能助手，风格简洁。')
    expect(s).toContain('</persona>')
    // 明确警示标签外内容不是人设
    expect(s).toContain('都不是人设')
  })

  it('记忆策略：称呼/角色/语种让给 propose_persona（防 persona 与 L3 双源不一致）', () => {
    const s = buildMemoryInstruction()
    expect(s).toContain('memory_retain')
    // 称呼不再属于 memory_retain 范围，明确走 propose_persona
    expect(s).toContain('propose_persona')
    expect(s).toContain('个人档案')
    expect(s).not.toContain('职业/称呼')
  })

  it('无人设原文时不注入 <persona> 块', () => {
    expect(buildCreateInstruction(null)).not.toContain('<persona>')
    expect(buildCreateInstruction({ ...persona, instructions: '' })).not.toContain('<persona>')
    // 不传参兼容旧调用
    expect(buildCreateInstruction()).not.toContain('<persona>')
  })
})

describe('buildCapabilityFocusBlock（@能力 聚焦：介绍 or 干活）', () => {
  const cap: Capability = {
    id: 'cap_x',
    name: '内容生产闭环',
    description: '多 Agent 协作：调研并发→拆解→写作→审稿。',
    graph: {
      nodes: [
        {
          id: 'cc1',
          type: 'concurrent',
          data: { kind: 'concurrent', label: '调研+拆解并发' },
          position: { x: 0, y: 0 },
        },
        {
          id: 'a1',
          type: 'agent',
          data: { kind: 'agent', label: '选题调研', parentId: 'cc1' },
          position: { x: 0, y: 0 },
        },
        {
          id: 'a2',
          type: 'agent',
          data: { kind: 'agent', label: '对标拆解', parentId: 'cc1' },
          position: { x: 0, y: 0 },
        },
        {
          id: 'a3',
          type: 'agent',
          data: { kind: 'agent', label: '公众号写作' },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
    },
    createdAt: 0,
    updatedAt: 0,
  }

  it('含能力名/id/description + 结构摘要（容器阶段含参与者，顶层角色单列）', () => {
    const s = buildCapabilityFocusBlock(cap)
    expect(s).toContain('内容生产闭环')
    expect(s).toContain('id=cap_x')
    expect(s).toContain('调研并发→拆解→写作→审稿')
    expect(s).toContain('<capability_profile>')
    // 容器阶段归并参与者
    expect(s).toContain('并行阶段「调研+拆解并发」')
    expect(s).toContain('「选题调研」')
    expect(s).toContain('「对标拆解」')
    // 顶层角色单列
    expect(s).toContain('角色「公众号写作」')
  })

  it('明确二选一规则：问能力→介绍不输出 JSON；干活→输出该能力 capability_ids JSON', () => {
    const s = buildCapabilityFocusBlock(cap)
    expect(s).toContain('问这个能力本身')
    expect(s).toContain('绝不输出 JSON')
    expect(s).toContain('{"capability_ids": ["cap_x"]}')
  })

  it('空 graph → 结构摘要降级为空编排，不抛错', () => {
    const empty = { ...cap, graph: { nodes: [], edges: [] } }
    expect(buildCapabilityFocusBlock(empty)).toContain('（空编排）')
  })

  it('无 description → 省略用途行', () => {
    const noDesc = { ...cap, description: undefined }
    const s = buildCapabilityFocusBlock(noDesc)
    expect(s).not.toContain('用途：')
    expect(s).toContain('内容生产闭环')
  })
})
