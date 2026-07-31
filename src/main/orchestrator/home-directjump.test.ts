import { describe, expect, it } from 'vitest'
import type { Agent, StreamEvent } from '@shared/types'
import { buildTeamGraph, runTeam } from './home'
import type { BuildDeps } from './builder'
import type { AgentExecutorOptions } from './patterns/agent'
import type { Agent as AgentClass } from './agent'

// —— @角色 直跳链路实证（问题2：空白气泡）——
// 验证单角色图经 buildTeamGraph → buildWorkflow → runWorkflow 后，
// output 非空且流式 output 事件正常发出。

function makeAgent(id: string, name: string): Agent {
  return { id, name, instructions: '你是助手', createdAt: 0, updatedAt: 0 }
}

/** mock Agent：流式吐两段 text，finalText 非空 */
function mockAgent(text: string): AgentClass {
  return {
    config: { name: 'x' },
    deps: {},
    async run(_input: unknown, callbacks?: { onText?: (t: string) => void }) {
      callbacks?.onText?.(text.slice(0, 3))
      callbacks?.onText?.(text.slice(3))
      return { messages: [], finalText: text, finalThinking: '' }
    },
  } as unknown as AgentClass
}

describe('@角色 直跳（单 agent 图）', () => {
  it('runWorkflow output 非空 + 流式 output 事件按 speaker 发出', async () => {
    const agent = makeAgent('a1', '翻译官')
    const graph = buildTeamGraph({ role_ids: ['a1'] }, (id) => (id === 'a1' ? agent : null), () => null)
    expect(graph).not.toBeNull()
    expect(graph!.nodes).toHaveLength(1)

    const deps: BuildDeps = {
      resolveAgent: (node): AgentExecutorOptions | null => ({
        config: {
          name: node.id,
          instructions: '你是助手',
          modelId: 'm',
          tools: [],
          defaultOptions: { maxTokens: 100 },
        },
        llmOpts: {},
        agent: mockAgent('我能做这些事') as never,
      }),
    }

    const events: StreamEvent[] = []
    const result = await runTeam(graph!, '你能做什么', 'sess1', deps, (e) => {
      if (e.type === 'orch_event') events.push(e.event)
    })

    // 最终 output 非空（前端历史气泡内容来源）
    expect(result.output).toBe('我能做这些事')
    // 流式 output 事件带 speaker（前端流式气泡来源）
    const outputs = events.filter((e) => e.type === 'output')
    expect(outputs.length).toBeGreaterThan(0)
    expect(outputs[0]).toMatchObject({ speaker: 'a1' })
    // 增量事件（非 final）拼接 = 完整文本；final 事件是终端完整输出（前端据此替换去重）
    const deltas = outputs.filter((e) => e.type === 'output' && !e.final)
    expect(deltas.map((e) => (e.type === 'output' ? e.text : '')).join('')).toBe('我能做这些事')
    const finals = outputs.filter((e) => e.type === 'output' && e.final)
    expect(finals).toHaveLength(1)
    expect(finals[0]).toMatchObject({ text: '我能做这些事', final: true })
  })
})
