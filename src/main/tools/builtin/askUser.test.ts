import { describe, expect, it, beforeEach } from 'vitest'
import { clearTools, executeTool, listToolDefs } from '../registry'
import { registerAskUserTools } from './askUser'

// —— HITL ask_user 工具单测 ——
// 三态：未注入 onAskUser（非交互环境）/ 用户作答 / 挂起被拒（超时/取消）。
// 一律返回 JSON 不抛异常（铁律11，防 LLM 重调死循环）。

describe('tools/builtin/askUser', () => {
  beforeEach(() => {
    clearTools()
    registerAskUserTools()
  })

  it('ask_user 已注册进工具清单（编排 agent 可见）', () => {
    const def = listToolDefs().find((d) => d.name === 'ask_user')
    expect(def).toBeDefined()
    expect(def!.input_schema).toMatchObject({ type: 'object' })
  })

  it('未注入 onAskUser：返回 user_input_unavailable 错误 JSON，不抛', async () => {
    const result = await executeTool('ask_user', { question: 'q' }, 'tu_1', {})
    expect(result.isError).toBe(true) // { ok: false } → 协议语义 is_error=true
    const parsed = JSON.parse(result.content) as { ok: boolean; error: string }
    expect(parsed).toMatchObject({ ok: false, error: 'user_input_unavailable' })
  })

  it('用户作答：onAskUser resolve → 答案作 JSON 返回', async () => {
    const seen: Array<{ question: string; context?: string }> = []
    const result = await executeTool(
      'ask_user',
      { question: '预算多少？', context: '要选配置档位' },
      'tu_2',
      {
        onAskUser: async (req) => {
          seen.push(req)
          return '5000 元'
        },
      },
    )
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content)).toEqual({ ok: true, answer: '5000 元' })
    expect(seen).toEqual([{ question: '预算多少？', context: '要选配置档位' }])
  })

  it('挂起被拒（超时/取消）：转错误 JSON 不抛，带继续提示', async () => {
    const result = await executeTool('ask_user', { question: 'q' }, 'tu_3', {
      onAskUser: async () => {
        throw new Error('user_input_timeout')
      },
    })
    expect(result.isError).toBe(true) // { ok: false } → 协议语义 is_error=true
    const parsed = JSON.parse(result.content) as { ok: boolean; error: string; hint: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toBe('user_input_timeout')
    expect(parsed.hint.length).toBeGreaterThan(0)
  })

  it('入参校验：缺 question → invalid_args', async () => {
    const result = await executeTool('ask_user', { context: 'x' }, 'tu_4', {})
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content).error).toBe('invalid_args')
  })
})
