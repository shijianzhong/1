import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CapabilitySchema } from '../config'
import { buildWorkflow } from './builder'
import type { AgentExecutorOptions } from './patterns/agent'
import type { AgentConfig } from '@shared/types'
import type { Agent } from './agent'

// —— 内容生产管线 Capability 校验（P4，docs/CONTENT_PIPELINE_PLAN.md §四）——
// ① JSON 过 CapabilitySchema（首启 seedBuiltinAssets 复制后能落库）
// ② graph 能 buildWorkflow（6 节点 sequential 线性接力可跑）
// ③ 所有 sourceAgentId 是已注册的 builtin agent id（运行时 resolveAgent 不返回 null）

// 文件名与 id 一致（builtin_content_pipeline），匹配 JsonCollection.get 按 {id}.json 读取
const CAP_PATH = join(
  process.cwd(),
  'build',
  'builtin',
  'capabilities',
  'builtin_content_pipeline.json',
)

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

describe('content-pipeline capability', () => {
  const raw = JSON.parse(readFileSync(CAP_PATH, 'utf8'))

  it('JSON 过 CapabilitySchema 且固定 id builtin_content_pipeline', () => {
    const cap = CapabilitySchema.parse(raw)
    expect(cap.id).toBe('builtin_content_pipeline')
    expect(cap.name).toBeTruthy()
  })

  it('graph 含 1 个 sequential 容器 + 6 个 agent 节点', () => {
    const nodes = raw.graph.nodes
    const seq = nodes.filter((n: { type: string }) => n.type === 'sequential')
    const agents = nodes.filter((n: { type: string }) => n.type === 'agent')
    expect(seq.length).toBe(1)
    expect(seq[0].data.isEntry).toBe(true)
    expect(seq[0].data.participants).toHaveLength(6)
    expect(agents.length).toBe(6)
  })

  it('6 个 agent 节点的 sourceAgentId 都是 builtin_content_*', () => {
    const agents = raw.graph.nodes.filter((n: { type: string }) => n.type === 'agent')
    for (const a of agents) {
      expect(a.data.sourceAgentId).toMatch(/^builtin_content_/)
    }
  })

  it('graph 能 buildWorkflow，6 节点线性接力（A1→A2→…→A6）', () => {
    const wf = buildWorkflow(raw.graph, { resolveAgent: (n) => mockOpts(n.id) })
    // sequential 容器布线：participants[0]→[1]→…→[5]
    const participants = raw.graph.nodes.find(
      (n: { type: string }) => n.type === 'sequential',
    ).data.participants
    for (let i = 0; i < participants.length - 1; i++) {
      expect(wf.edges.get(participants[i])).toContain(participants[i + 1])
    }
  })
})
