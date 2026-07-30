import { describe, expect, it } from 'vitest'
import type { Agent, Capability } from '@shared/types'
import {
  TeamJsonDetector,
  buildRoutingInstruction,
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
})

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
