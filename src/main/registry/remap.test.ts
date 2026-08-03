import { describe, expect, it } from 'vitest'
import type { WorkflowGraph } from '@shared/types'
import { remapGraphForImport } from './remap'

// —— remapGraphForImport（docs/REGISTRY_PLAN.md §3.2 链路三）——
// skillIds slug→本地 id；sourceAgentId 按 materializeAgents 取舍；modelId 防御性剥离；
// 容器节点不动；缺映射剔除并汇总 droppedSkillSlugs。

function makeGraph(): WorkflowGraph {
  return {
    nodes: [
      {
        id: 'n1',
        type: 'agent',
        position: { x: 0, y: 0 },
        data: {
          name: '调研员',
          instructions: '...',
          skillIds: ['web-research', 'missing-skill'],
          sourceAgentId: 'researcher',
          modelId: 'mdl_local_only',
        },
      },
      {
        id: 'n2',
        type: 'agent',
        position: { x: 0, y: 0 },
        data: { name: '写手', instructions: '...', agentId: 'writer' },
      },
      {
        id: 'gc',
        type: 'groupchat',
        position: { x: 0, y: 0 },
        data: { participants: ['n1', 'n2'] },
      },
    ],
    edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
  } as unknown as WorkflowGraph
}

describe('remapGraphForImport', () => {
  it('skillIds 重映射为本地 id，缺映射剔除并汇总', () => {
    const { graph, droppedSkillSlugs } = remapGraphForImport(
      makeGraph(),
      { skills: new Map([['web-research', 'skl_1']]), agents: new Map() },
      { materializeAgents: false },
    )
    const n1 = graph.nodes[0]
    expect((n1.data as Record<string, unknown>).skillIds).toEqual(['skl_1'])
    expect(droppedSkillSlugs).toEqual(['missing-skill'])
  })

  it('materializeAgents=true 时 sourceAgentId/agentId 映射为本地 id', () => {
    const { graph } = remapGraphForImport(
      makeGraph(),
      {
        skills: new Map([['web-research', 'skl_1'], ['missing-skill', 'skl_2']]),
        agents: new Map([['researcher', 'agt_1'], ['writer', 'agt_2']]),
      },
      { materializeAgents: true },
    )
    expect((graph.nodes[0].data as Record<string, unknown>).sourceAgentId).toBe('agt_1')
    expect((graph.nodes[1].data as Record<string, unknown>).agentId).toBe('agt_2')
  })

  it('materializeAgents=false 时剔除 sourceAgentId/agentId，快照自足', () => {
    const { graph } = remapGraphForImport(
      makeGraph(),
      { skills: new Map(), agents: new Map([['researcher', 'agt_1']]) },
      { materializeAgents: false },
    )
    expect((graph.nodes[0].data as Record<string, unknown>).sourceAgentId).toBeUndefined()
    expect((graph.nodes[1].data as Record<string, unknown>).agentId).toBeUndefined()
  })

  it('依赖未物化（map 中缺失）时剔除引用而非留 slug', () => {
    const { graph } = remapGraphForImport(
      makeGraph(),
      { skills: new Map(), agents: new Map() }, // researcher 不在 map
      { materializeAgents: true },
    )
    expect((graph.nodes[0].data as Record<string, unknown>).sourceAgentId).toBeUndefined()
  })

  it('modelId 一律剥离（本地 ModelConfig id 不可移植）', () => {
    const { graph } = remapGraphForImport(
      makeGraph(),
      { skills: new Map(), agents: new Map() },
      { materializeAgents: false },
    )
    expect((graph.nodes[0].data as Record<string, unknown>).modelId).toBeUndefined()
  })

  it('容器节点与边原样保留；skillIds 全缺映射时删除字段而非留空数组', () => {
    const { graph } = remapGraphForImport(
      makeGraph(),
      { skills: new Map(), agents: new Map() },
      { materializeAgents: false },
    )
    const gc = graph.nodes[2]
    expect((gc.data as Record<string, unknown>).participants).toEqual(['n1', 'n2'])
    expect(graph.edges).toHaveLength(1)
    // n2 无 skillIds 字段；n1 的 skillIds 全缺映射 → 字段被删除
    expect((graph.nodes[0].data as Record<string, unknown>).skillIds).toBeUndefined()
  })
})
