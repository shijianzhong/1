import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, HomeStreamEvent, LlmResponse, StreamEvent } from '@shared/types'
import { buildTeamGraph, runTeam } from './home'
import type { BuildDeps } from './builder'
import type { AgentExecutorOptions } from './patterns/agent'

// —— 决定性实证：Deepseek thinking 场景 @角色 直跳管线 ——
// mock 最底层 LLM client（retry.getClient），模拟 Deepseek 流式返回
// thinking delta + text delta，走真实 Agent → AgentExecutor → runTeam，
// 追踪 emitStream 事件序列与最终 output，定位空白气泡根因。

// mock retry.getClient：返回流式吐 thinking + text 的 fake client
vi.mock('../llm/retry', () => ({
  getClient: () => ({
    async stream(req: {
      onDelta?: (d: { type: string; text?: string }) => void
    }): Promise<LlmResponse> {
      // 模拟 Deepseek：先 thinking（推理过程），后 text（正式回答）
      req.onDelta?.({ type: 'thinking', text: '用户在问我的能力，我应该介绍自己。' })
      req.onDelta?.({ type: 'text', text: '我是公众号写作助手，' })
      req.onDelta?.({ type: 'text', text: '能帮你选题、写稿、配图。' })
      return {
        stopReason: 'end_turn',
        content: [
          { type: 'thinking', thinking: '用户在问我的能力，我应该介绍自己。', signature: 'sig' },
          { type: 'text', text: '我是公众号写作助手，能帮你选题、写稿、配图。' },
        ],
      }
    },
  }),
}))

function makeAgent(id: string, name: string): Agent {
  return { id, name, instructions: '你是公众号写作助手', createdAt: 0, updatedAt: 0 }
}

describe('@角色 直跳（Deepseek thinking 真实场景）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('finalText 只含 text 正文（不含 thinking），output 非空，流式无 thinking 混入', async () => {
    const agent = makeAgent('agt_wechat_writing', '公众号写作')
    const graph = buildTeamGraph(
      { role_ids: ['agt_wechat_writing'] },
      (id) => (id === 'agt_wechat_writing' ? agent : null),
      () => null,
    )
    expect(graph).not.toBeNull()

    const deps: BuildDeps = {
      resolveAgent: (node): AgentExecutorOptions | null => ({
        config: {
          name: node.id,
          instructions: '你是公众号写作助手',
          modelId: 'deepseek-v4-flash',
          tools: [],
          defaultOptions: { maxTokens: 16384 },
          thinking: { type: 'enabled', budgetTokens: 4096 },
        },
        llmOpts: {},
      }),
    }

    const events: StreamEvent[] = []
    const result = await runTeam(graph!, '你能做什么', 'sess1', deps, (e) => {
      if (e.type === 'orch_event') events.push(e.event)
    })

    // 最终 output = 纯 text 正文（不含 thinking 推理）
    expect(result.output).toBe('我是公众号写作助手，能帮你选题、写稿、配图。')
    expect(result.output).not.toContain('用户在问我的能力')

    // 流式 output 事件：只含 text 正文增量 + final 完整，不含 thinking
    const outputs = events.filter((e) => e.type === 'output')
    const allText = outputs.map((e) => (e.type === 'output' ? e.text : '')).join('')
    expect(allText).not.toContain('用户在问我的能力')
    // 增量累加 = 正文；final 替换 = 正文（去重后不为空）
    const deltas = outputs.filter((e) => e.type === 'output' && !e.final)
    expect(deltas.map((e) => (e.type === 'output' ? e.text : '')).join('')).toBe(
      '我是公众号写作助手，能帮你选题、写稿、配图。',
    )
    const final = outputs.find((e) => e.type === 'output' && e.final)
    expect(final).toMatchObject({ text: '我是公众号写作助手，能帮你选题、写稿、配图。', final: true })
  })
})
