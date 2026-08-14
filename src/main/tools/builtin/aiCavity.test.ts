import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { clearTools, executeTool, listToolDefs } from '../registry'
import { registerAiCavityTools } from './aiCavity'

// —— ai_cavity_audit 规则预筛单测（内容生产 §2.5 第一层）——
// 只测规则定位逻辑：根源A自造说法 + 根源B英译式连接词 + ≥3封顶。
// 不测 LLM 判断（那是 A6 agent 的职责）。

function parse(r: { content: string; isError: boolean }): Record<string, unknown> {
  return JSON.parse(r.content)
}

describe('ai_cavity_audit', () => {
  beforeEach(() => {
    clearTools()
    registerAiCavityTools()
  })
  afterEach(() => clearTools())

  it('工具注册进清单（编排 agent 可见）', () => {
    const names = listToolDefs().map((t) => t.name)
    expect(names).toContain('ai_cavity_audit')
  })

  it('空文本 → 结构化错误（isError=true，带 messageKey）', async () => {
    const r = await executeTool('ai_cavity_audit', { text: '   ' }, 'tu_1', {})
    const data = parse(r)
    expect(r.isError).toBe(true)
    expect(data.ok).toBe(false)
    expect(data.messageKey).toBe('errors.tools.ai_cavity_empty')
  })

  it('检测根源B：英译式连接词"反映出"', async () => {
    const text = '多家公司增加交付人员，反映出企业仍需处理数据和流程问题。'
    const r = await executeTool('ai_cavity_audit', { text }, 'tu_2', {})
    const data = parse(r)
    expect(r.isError).toBe(false)
    expect(data.ok).toBe(true)
    const hits = data.hits as Array<{ type: string; marker: string }>
    const bHits = hits.filter((h) => h.type === 'english_connection_misuse')
    expect(bHits.length).toBeGreaterThanOrEqual(1)
    expect(bHits[0].marker).toBe('反映出')
  })

  it('检测根源A：抽象红利/自造说法', async () => {
    const text = '这个项目释放了巨大的红利。'
    const r = await executeTool('ai_cavity_audit', { text }, 'tu_3', {})
    const data = parse(r)
    expect(r.isError).toBe(false)
    expect(data.ok).toBe(true)
    const hits = data.hits as Array<{ type: string }>
    const aHits = hits.filter((h) => h.type === 'self_invented_term')
    expect(aHits.length).toBeGreaterThanOrEqual(1)
  })

  it('命中 ≥3 处 → capped=true', async () => {
    const text = [
      '多家公司增加交付人员，反映出企业仍需处理数据问题。',
      '这表明了行业进入新阶段。',
      '由此可见，底层逻辑已经打通。',
    ].join('')
    const r = await executeTool('ai_cavity_audit', { text }, 'tu_4', {})
    const data = parse(r)
    expect(r.isError).toBe(false)
    expect(data.totalHits).toBeGreaterThanOrEqual(3)
    expect(data.capped).toBe(true)
  })

  it('干净文本 → 零命中，capped=false', async () => {
    const text = '这个项目用 TypeScript 写的，有一千二百个 star。成本下降了三成。'
    const r = await executeTool('ai_cavity_audit', { text }, 'tu_5', {})
    const data = parse(r)
    expect(r.isError).toBe(false)
    expect(data.totalHits).toBe(0)
    expect(data.capped).toBe(false)
  })
})
