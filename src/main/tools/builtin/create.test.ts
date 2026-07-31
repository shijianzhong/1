import { describe, expect, it, beforeEach } from 'vitest'
import { clearTools, executeTool } from '../registry'
import { registerCreateTools } from './create'
import type { CreateDraft } from '@shared/types'

// —— 聊天创建工具单测（propose_* 不落库，经 onPropose 桥推草稿）——

describe('tools/builtin/create', () => {
  beforeEach(() => {
    clearTools()
    registerCreateTools()
  })

  it('propose_agent：产出 agent 草稿并经 onPropose 桥推出，不落库', async () => {
    const drafts: CreateDraft[] = []
    const result = await executeTool(
      'propose_agent',
      { name: '翻译官', instructions: '你是中英互译专家', description: '互译' },
      'tu_a1',
      { onPropose: (d) => drafts.push(d) },
    )
    expect(result.isError).toBe(false)
    const parsed = JSON.parse(result.content) as { ok: boolean; draftId: string; kind: string }
    expect(parsed.ok).toBe(true)
    expect(parsed.kind).toBe('agent')
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({
      draftId: parsed.draftId,
      kind: 'agent',
      payload: { name: '翻译官', instructions: '你是中英互译专家' },
    })
  })

  it('propose_skill：产出 skill 草稿', async () => {
    const drafts: CreateDraft[] = []
    await executeTool(
      'propose_skill',
      { name: '周报', content: '# 周报模板\n...', discipline: '≤300字' },
      'tu_s1',
      { onPropose: (d) => drafts.push(d) },
    )
    expect(drafts[0]).toMatchObject({
      kind: 'skill',
      payload: { name: '周报', content: '# 周报模板\n...', discipline: '≤300字' },
    })
  })

  it('propose_capability：合法 graph 产出 capability 草稿', async () => {
    const drafts: CreateDraft[] = []
    const graph = {
      nodes: [
        { id: 'a', type: 'agent', data: { label: '写手', instructions: '写' }, position: { x: 0, y: 0 } },
      ],
      edges: [],
    }
    const result = await executeTool(
      'propose_capability',
      { name: '写作流', graph },
      'tu_c1',
      { onPropose: (d) => drafts.push(d) },
    )
    expect(result.isError).toBe(false)
    expect(drafts[0]).toMatchObject({ kind: 'capability', payload: { name: '写作流', graph } })
  })

  it('propose_capability：非法 graph（空 nodes）被 zod 拦截返回错误 JSON', async () => {
    const drafts: CreateDraft[] = []
    const result = await executeTool(
      'propose_capability',
      { name: '坏图', graph: { nodes: [], edges: [] } },
      'tu_c2',
      { onPropose: (d) => drafts.push(d) },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('invalid_args')
    expect(drafts).toHaveLength(0)
  })

  it('propose_agent：无 onPropose 桥时仍返回 ok（不抛，仅不推前端）', async () => {
    const result = await executeTool(
      'propose_agent',
      { name: '孤独角色', instructions: 'x' },
      'tu_a2',
      {},
    )
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content).ok).toBe(true)
  })
})
