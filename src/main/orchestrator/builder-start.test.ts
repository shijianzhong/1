import { describe, expect, it } from 'vitest'
import { resolveStartExecutor } from './builder'
import type { GraphNode, WorkflowGraph } from '@shared/types'

// —— resolveStartExecutor 入口解析（拓扑感知 + 容器递归）——
// 覆盖：agent / sequential / concurrent / groupchat 容器作入口；入口不在 nodes[0]；
// 嵌套容器；无入边拓扑起点判定。

const agent = (id: string, parentId?: string): GraphNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: id, instructions: 'x', ...(parentId ? { parentId } : {}) },
})

function graph(nodes: GraphNode[], edges: Array<[string, string]> = []): WorkflowGraph {
  return { nodes, edges: edges.map(([source, target]) => ({ source, target })) }
}

describe('resolveStartExecutor', () => {
  it('单 agent：入口即自身', () => {
    expect(resolveStartExecutor(graph([agent('A')]))).toBe('A')
  })

  it('sequential 容器作入口（nodes[0]）→ 首个 participant', () => {
    const g = graph([
      { id: 'seq', type: 'sequential', position: { x: 0, y: 0 }, data: { participants: ['A', 'B'] } },
      agent('A', 'seq'),
      agent('B', 'seq'),
    ])
    expect(resolveStartExecutor(g)).toBe('A')
  })

  it('concurrent 容器作入口 → 容器自身（ConcurrentExecutor 是 dispatcher）', () => {
    const g = graph([
      { id: 'conc', type: 'concurrent', position: { x: 0, y: 0 }, data: { participants: ['A', 'B'], aggregator: 'agg' } },
      agent('A', 'conc'),
      agent('B', 'conc'),
      agent('agg', 'conc'),
    ])
    expect(resolveStartExecutor(g)).toBe('conc')
  })

  it('groupchat 容器作入口 → 容器自身（GroupChatExecutor 是协调器）', () => {
    const g = graph([
      { id: 'gc', type: 'groupchat', position: { x: 0, y: 0 }, data: { participants: ['A', 'B'] } },
      agent('A', 'gc'),
      agent('B', 'gc'),
    ])
    expect(resolveStartExecutor(g)).toBe('gc')
  })

  it('handoff 容器作入口 → 容器自身（HandoffExecutor 路由 start_agent）', () => {
    const g = graph([
      { id: 'ho', type: 'handoff', position: { x: 0, y: 0 }, data: { participants: ['A', 'B'], start_agent: 'A' } },
      agent('A', 'ho'),
      agent('B', 'ho'),
    ])
    expect(resolveStartExecutor(g)).toBe('ho')
  })

  it('入口不在 nodes[0]：选无入边的拓扑起点而非数组首元素', () => {
    // B → A（B 是入口，但 A 排在 nodes[0]）
    const g = graph([agent('A'), agent('B')], [['B', 'A']])
    expect(resolveStartExecutor(g)).toBe('B')
  })

  it('嵌套容器：sequential 首 participant 是另一 sequential → 递归到 agent', () => {
    const g = graph([
      { id: 'outer', type: 'sequential', position: { x: 0, y: 0 }, data: { participants: ['inner', 'C'] } },
      { id: 'inner', type: 'sequential', position: { x: 0, y: 0 }, data: { participants: ['A', 'B'], parentId: 'outer' } },
      agent('A', 'inner'),
      agent('B', 'inner'),
      agent('C', 'outer'),
    ])
    expect(resolveStartExecutor(g)).toBe('A')
  })

  it('嵌套：sequential 首 participant 是 concurrent 容器 → 返回该容器', () => {
    const g = graph([
      { id: 'outer', type: 'sequential', position: { x: 0, y: 0 }, data: { participants: ['conc', 'C'] } },
      { id: 'conc', type: 'concurrent', position: { x: 0, y: 0 }, data: { participants: ['A', 'B'], aggregator: 'agg', parentId: 'outer' } },
      agent('A', 'conc'),
      agent('B', 'conc'),
      agent('agg', 'conc'),
      agent('C', 'outer'),
    ])
    expect(resolveStartExecutor(g)).toBe('conc')
  })

  it('容器子节点不被误判为入口（parentId 排除）', () => {
    // 容器子节点 A 无入边，但它有 parentId → 不是入口；入口是 sequential 容器 → 解析到 A
    const g = graph([
      agent('A', 'seq'),
      { id: 'seq', type: 'sequential', position: { x: 0, y: 0 }, data: { participants: ['A'] } },
    ])
    expect(resolveStartExecutor(g)).toBe('A')
  })

  it('sequential 无有效 participant → 兜底首个 agent', () => {
    const g = graph([
      { id: 'seq', type: 'sequential', position: { x: 0, y: 0 }, data: { participants: ['MISSING'] } },
      agent('A'),
    ])
    expect(resolveStartExecutor(g)).toBe('A')
  })

  it('空图 → 空串', () => {
    expect(resolveStartExecutor({ nodes: [], edges: [] })).toBe('')
  })

  it('多入口候选取 nodes 顺序第一个', () => {
    // A、B 皆顶层无入边 → 取数组顺序第一个
    const g = graph([agent('A'), agent('B')])
    expect(resolveStartExecutor(g)).toBe('A')
  })

  // —— 显式入口（data.isEntry）优先于拓扑推导 ——
  it('显式 isEntry 优先：agent 设 isEntry 覆盖拓扑起点', () => {
    // 拓扑上 A 无入边是起点，但 B 显式设 isEntry → 选 B
    const g: WorkflowGraph = {
      nodes: [
        { id: 'A', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'A' } },
        { id: 'B', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'B', isEntry: true } },
      ],
      edges: [],
    }
    expect(resolveStartExecutor(g)).toBe('B')
  })

  it('显式入口：容器设 isEntry（concurrent → 容器自身）', () => {
    const g: WorkflowGraph = {
      nodes: [
        { id: 'A', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'A' } },
        { id: 'conc', type: 'concurrent', position: { x: 0, y: 0 }, data: { participants: ['P1'], aggregator: 'agg', isEntry: true } },
        { id: 'P1', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'P1', parentId: 'conc' } },
        { id: 'agg', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'agg', parentId: 'conc' } },
      ],
      edges: [],
    }
    expect(resolveStartExecutor(g)).toBe('conc')
  })

  it('显式入口：sequential 容器设 isEntry → 首 participant', () => {
    const g: WorkflowGraph = {
      nodes: [
        { id: 'A', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'A' } },
        { id: 'seq', type: 'sequential', position: { x: 0, y: 0 }, data: { participants: ['P1', 'P2'], isEntry: true } },
        { id: 'P1', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'P1', parentId: 'seq' } },
        { id: 'P2', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'P2', parentId: 'seq' } },
      ],
      edges: [],
    }
    expect(resolveStartExecutor(g)).toBe('P1')
  })

  it('participant 的 isEntry 被忽略（仅顶层节点可设入口）', () => {
    // P1 是容器子节点且误设 isEntry → 不生效，仍按拓扑取容器
    const g: WorkflowGraph = {
      nodes: [
        { id: 'seq', type: 'sequential', position: { x: 0, y: 0 }, data: { participants: ['P1', 'P2'] } },
        { id: 'P1', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'P1', parentId: 'seq', isEntry: true } },
        { id: 'P2', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'P2', parentId: 'seq' } },
      ],
      edges: [],
    }
    // 拓扑起点是 seq（顶层无入边）→ 解析到首 participant P1（碰巧同 id，但语义是 seq→P1）
    expect(resolveStartExecutor(g)).toBe('P1')
  })

  it('多个显式入口取 nodes 顺序第一个', () => {
    const g: WorkflowGraph = {
      nodes: [
        { id: 'A', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'A', isEntry: true } },
        { id: 'B', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'B', isEntry: true } },
      ],
      edges: [],
    }
    expect(resolveStartExecutor(g)).toBe('A')
  })
})
