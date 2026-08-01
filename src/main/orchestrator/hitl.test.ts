import { describe, expect, it, vi } from 'vitest'
import type { LlmMessage, LlmResponse } from '@shared/types'
import { Agent } from './agent'
import { registerAskUserTools } from '../tools/builtin/askUser'
import { newRequestId, resolveUserInput, waitForUserInput } from './userInput'

// —— HITL 全链路集成测试（mock 最底层 LLM client，走真实 Agent tool 循环）——
// 验证链：LLM tool_use(ask_user) → executeTool → onAskUser → userInput 挂起
//        → 外部应答 resolveUserInput → tool_result 回灌 → LLM 二轮拿到答案收尾。

const secondCallMessages: LlmMessage[][] = []

// 第一轮：要求问预算（tool_use）；第二轮：把 tool_result 里的答案复述收尾
vi.mock('../llm/retry', () => ({
  getClient: () => {
    let round = 0
    return {
      async stream(req: { messages: LlmMessage[] }): Promise<LlmResponse> {
        round++
        if (round === 1) {
          return {
            stopReason: 'tool_use',
            content: [
              { type: 'tool_use', id: 'tu_1', name: 'ask_user', input: { question: '预算多少？', context: '要选配置' } },
            ],
          }
        }
        secondCallMessages.push([...req.messages]) // 快照：Agent 后续还会 push 污染引用
        const last = req.messages[req.messages.length - 1]
        const resultBlock = Array.isArray(last.content) ? last.content[0] : null
        const resultText =
          resultBlock && resultBlock.type === 'tool_result' ? resultBlock.content : ''
        const answer = JSON.parse(resultText).answer
        return {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: `收到预算 ${answer}，推荐入门款` }],
        }
      },
    }
  },
}))

describe('HITL ask_user 全链路（Agent tool 循环 ↔ userInput 应答队列）', () => {
  it('提问挂起 → 用户作答 → tool_result 回灌 → LLM 拿到答案收尾', async () => {
    registerAskUserTools()
    const events: Array<Record<string, unknown>> = []

    const agent = new Agent(
      {
        name: 'buyer',
        instructions: '你是采购助手',
        modelId: 'fake-model',
        toolNames: ['ask_user'],
        defaultOptions: { maxTokens: 1024 },
      },
      {
        llmOpts: {},
        toolCtx: {
          onAskUser: ({ question, context }) => {
            const requestId = newRequestId()
            events.push({ type: 'request_info', request_id: requestId, question, context })
            const pending = waitForUserInput(requestId, { nodeId: 'buyer', question })
            // 模拟渲染层 orchestrate:respond 应答
            setTimeout(() => {
              resolveUserInput(requestId, '5000')
              events.push({ type: 'request_resolved', request_id: requestId, response: '5000' })
            }, 10)
            return pending
          },
        },
      },
    )

    const { finalText } = await agent.run({
      messages: [{ role: 'user', content: [{ type: 'text', text: '帮我买台服务器' }] }],
    })

    // LLM 收尾拿到用户答案
    expect(finalText).toBe('收到预算 5000，推荐入门款')
    // 事件序：request_info → request_resolved
    expect(events.map((e) => e.type)).toEqual(['request_info', 'request_resolved'])
    // 二轮请求里 tool_use 与 tool_result 配对（防 Anthropic 2013）
    // messages 结构：[输入 user, assistant(tool_use), user(tool_result)]
    const msgs = secondCallMessages[0]
    const assistantMsg = [...msgs].reverse().find((m) => m.role === 'assistant')
    const userMsg = msgs[msgs.length - 1]
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg?.role).toBe('assistant')
    expect(userMsg.role).toBe('user')
    const toolUse = Array.isArray(assistantMsg?.content) ? assistantMsg.content[0] : null
    const toolResult = Array.isArray(userMsg.content) ? userMsg.content[0] : null
    expect(toolUse?.type).toBe('tool_use')
    expect(toolResult?.type).toBe('tool_result')
    if (toolResult?.type === 'tool_result') expect(toolResult.tool_use_id).toBe('tu_1')
  })

  it('非交互环境（未注入 onAskUser）→ 错误 JSON 不抛异常，LLM 自行继续', async () => {
    registerAskUserTools()
    const agent = new Agent(
      {
        name: 'buyer',
        instructions: '你是采购助手',
        modelId: 'fake-model',
        toolNames: ['ask_user'],
        defaultOptions: { maxTokens: 1024 },
      },
      { llmOpts: {} },
    )
    // 第一轮仍返回 tool_use；ask_user 未注入 onAskUser → 工具回错误 JSON → 二轮收尾
    const { finalText } = await agent.run({
      messages: [{ role: 'user', content: [{ type: 'text', text: '帮我买台服务器' }] }],
    })
    // 二轮 fake 会解析 tool_result；错误 JSON 无 answer 字段 → answer undefined，但流程不崩
    expect(finalText).toContain('推荐入门款')
  })
})
