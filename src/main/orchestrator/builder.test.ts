import { describe, expect, it, vi } from 'vitest'
import type { AgentConfig, WorkflowGraph } from '@shared/types'
import type { Agent } from './agent'
import { buildWorkflow } from './builder'
import type { AgentExecutorOptions } from './patterns/agent'

// —— builder 显式边过滤（容器子节点连线不进运行时）——
// 容器内部布线由 pattern builder 决定；graph.edges 里触及子节点
// （data.parentId 非空）的边必须被跳过，防止双投递/未检测环。

function mockOpts(name: string): AgentExecutorOptions {
  const config: AgentConfig = {
    name,
    instructions: `你是 ${name}`,
    modelId: 'mock',
    defaultOptions: { maxTokens: 16384 },
  }
  const agent = {
    config,
    deps: {},
    run: vi.fn(async () => ({ messages: [], finalText: `${name} 产出` })),
  } as unknown as Agent
  return { config, llmOpts: {}, agent }
}

function agentNode(id: string, parentId?: string) {
  return {
    id,
    type: 'agent' as const,
    data: { label: id, ...(parentId ? { parentId } : {}) },
    position: { x: 0, y: 0 },
  }
}

describe('buildWorkflow 显式边过滤', () => {
  it('跳过容器子节点间的遗留边，pattern 布线不受污染', () => {
    const graph: WorkflowGraph = {
      nodes: [
        {
          id: 'seq1',
          type: 'sequential',
          data: { label: 'seq1', participants: ['A', 'B'] },
          position: { x: 0, y: 0 },
        },
        agentNode('A', 'seq1'),
        agentNode('B', 'seq1'),
      ],
      // 历史遗留：用户曾在容器内手连 B→A（与 pattern 的 A→B 会组成环）
      edges: [{ source: 'B', target: 'A' }],
    }

    const wf = buildWorkflow(graph, { resolveAgent: (n) => mockOpts(n.id) })

    // pattern 布线保留：A→B
    expect(wf.edges.get('A')).toEqual(['B'])
    // 子节点显式边被跳过：B 无出边
    expect(wf.edges.get('B')).toBeUndefined()
  })

  it('顶层节点显式边正常保留（sequential 容器出边改写为末 participant 发出）', () => {
    const graph: WorkflowGraph = {
      nodes: [
        {
          id: 'seq1',
          type: 'sequential',
          data: { label: 'seq1', participants: ['A'] },
          position: { x: 0, y: 0 },
        },
        agentNode('A', 'seq1'),
        agentNode('C'), // 顶层 agent
      ],
      edges: [
        { source: 'seq1', target: 'C' }, // 容器 → 顶层 agent：改写为 A→C（容器无 executor，原样保留是死边）
        { source: 'A', target: 'C' }, // 子节点 → 顶层，跳过
      ],
    }

    const wf = buildWorkflow(graph, { resolveAgent: (n) => mockOpts(n.id) })

    expect(wf.edges.get('seq1')).toBeUndefined()
    expect(wf.edges.get('A')).toEqual(['C'])
  })

  it('sequential 容器边界边改写：X→S 投首 participant，S→Y 由末 participant 发出，条件保留', () => {
    const graph: WorkflowGraph = {
      nodes: [
        agentNode('X'),
        {
          id: 'S',
          type: 'sequential',
          data: { label: 'S', participants: ['A', 'B'] },
          position: { x: 0, y: 0 },
        },
        agentNode('A', 'S'),
        agentNode('B', 'S'),
        agentNode('Y'),
        agentNode('Z'),
      ],
      edges: [
        { source: 'X', target: 'S' },
        { source: 'S', target: 'Y' },
        { source: 'S', target: 'Z', condition: 'contains:go' },
      ],
    }

    const wf = buildWorkflow(graph, { resolveAgent: (n) => mockOpts(n.id) })

    // 入边改写：X→S ⇒ X→首 participant A
    expect(wf.edges.get('X')).toEqual(['A'])
    // 出边改写：S→Y ⇒ 末 participant B→Y；条件边 S→Z ⇒ conditions 挂在 B 上
    expect(wf.edges.get('B')).toEqual(['Y'])
    expect(wf.conditions.get('B')).toEqual([{ predicate: 'contains:go', target: 'Z' }])
    // pattern 线性边保留：A→B
    expect(wf.edges.get('A')).toEqual(['B'])
    // 容器自身无运行时边
    expect(wf.edges.get('S')).toBeUndefined()
  })
})
