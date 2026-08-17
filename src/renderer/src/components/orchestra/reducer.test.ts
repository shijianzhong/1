import { describe, expect, it } from 'vitest'
import { applyOrchEvent, closeStreaming } from './reducer'
import type { ChatMessage } from './types'

// —— 编排流事件 reducer 单测（HomePage/EditorPage 共用渲染逻辑）——

const userMsg = (text: string): ChatMessage => ({
  id: crypto.randomUUID(),
  role: 'user',
  text,
})

describe('orchestra/reducer applyOrchEvent', () => {
  it('output 增量：同 speaker 末条流式气泡累加', () => {
    let msgs = applyOrchEvent([], { type: 'output', node_id: 'a1', speaker: 'a1', text: '你好' })
    msgs = applyOrchEvent(msgs, { type: 'output', node_id: 'a1', speaker: 'a1', text: '世界' })
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ speaker: 'a1', text: '你好世界', streaming: true })
  })

  it('output final：替换增量文本（去重），并定格流式', () => {
    let msgs = applyOrchEvent([], { type: 'output', node_id: 'a1', speaker: 'a1', text: '你' })
    msgs = applyOrchEvent(msgs, { type: 'output', node_id: 'a1', speaker: 'a1', text: '你好', final: true })
    expect(msgs[0]).toMatchObject({ text: '你好', streaming: false })
  })

  it('不同 speaker：开新气泡，旧气泡定格', () => {
    let msgs = applyOrchEvent([], { type: 'output', node_id: 'a1', speaker: 'a1', text: '甲' })
    msgs = applyOrchEvent(msgs, { type: 'output', node_id: 'b2', speaker: 'b2', text: '乙' })
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toMatchObject({ speaker: 'a1', streaming: false })
    expect(msgs[1]).toMatchObject({ speaker: 'b2', text: '乙', streaming: true })
  })

  it('node_error / failed → 错误气泡', () => {
    const msgs = applyOrchEvent([], { type: 'node_error', node_id: 'a1', error: 'boom' })
    expect(msgs[0]).toMatchObject({ error: true, text: 'a1: boom' })
    const msgs2 = applyOrchEvent([], { type: 'failed', error: '整体失败' })
    expect(msgs2[0]).toMatchObject({ error: true, text: '整体失败' })
  })

  it('request_info → pending 提问卡，且定格既有流式气泡', () => {
    const prev = applyOrchEvent([], { type: 'output', node_id: 'a1', speaker: 'a1', text: '问下' })
    const msgs = applyOrchEvent(prev, {
      type: 'request_info',
      request_id: 'req_1',
      node_id: 'a1',
      question: '预算多少？',
      context: '要选档位',
    })
    expect(msgs).toHaveLength(2)
    expect(msgs[0].streaming).toBe(false)
    expect(msgs[1].askUser).toMatchObject({
      requestId: 'req_1',
      nodeId: 'a1',
      question: '预算多少？',
      context: '要选档位',
      status: 'pending',
    })
  })

  it('request_resolved：非空 → answered 带答案', () => {
    let msgs = applyOrchEvent([], {
      type: 'request_info',
      request_id: 'req_1',
      node_id: 'a1',
      question: 'q',
    })
    msgs = applyOrchEvent(msgs, {
      type: 'request_resolved',
      request_id: 'req_1',
      node_id: 'a1',
      response: '5000',
    })
    expect(msgs[0].askUser).toMatchObject({ status: 'answered', response: '5000' })
  })

  it('request_resolved：空 → expired（超时/取消）', () => {
    let msgs = applyOrchEvent([], {
      type: 'request_info',
      request_id: 'req_1',
      node_id: 'a1',
      question: 'q',
    })
    msgs = applyOrchEvent(msgs, {
      type: 'request_resolved',
      request_id: 'req_1',
      node_id: 'a1',
      response: '',
    })
    expect(msgs[0].askUser).toMatchObject({ status: 'expired' })
  })

  it('request_resolved 幂等：已 answered 不再被后续事件改动', () => {
    let msgs = applyOrchEvent([], {
      type: 'request_info',
      request_id: 'req_1',
      node_id: 'a1',
      question: 'q',
    })
    msgs = applyOrchEvent(msgs, { type: 'request_resolved', request_id: 'req_1', node_id: 'a1', response: 'a' })
    msgs = applyOrchEvent(msgs, { type: 'request_resolved', request_id: 'req_1', node_id: 'a1', response: '' })
    expect(msgs[0].askUser).toMatchObject({ status: 'answered', response: 'a' })
  })

  it('node_started/node_done/handoff/done 不产生气泡', () => {
    const prev = [userMsg('任务')]
    expect(applyOrchEvent(prev, { type: 'node_started', node_id: 'a1' })).toHaveLength(1)
    expect(applyOrchEvent(prev, { type: 'node_done', node_id: 'a1' })).toHaveLength(1)
    expect(applyOrchEvent(prev, { type: 'handoff', from: 'a1', to: 'b2' })).toHaveLength(1)
    expect(applyOrchEvent(prev, { type: 'done' })).toHaveLength(1)
  })

  it('done 定格流式态（防御 message_stop 丢失导致 streaming 泄漏）', () => {
    const prev = applyOrchEvent([], { type: 'output', node_id: 'a1', speaker: 'a1', text: '流式中' })
    expect(prev[0].streaming).toBe(true)
    const msgs = applyOrchEvent(prev, { type: 'done' })
    expect(msgs).toHaveLength(1)
    expect(msgs[0].streaming).toBe(false)
  })

  it('closeStreaming：定格全部流式气泡', () => {
    const msgs: ChatMessage[] = [
      { id: '1', role: 'assistant', text: 'a', streaming: true },
      { id: '2', role: 'assistant', text: 'b', streaming: true },
    ]
    expect(closeStreaming(msgs).every((m) => !m.streaming)).toBe(true)
  })

  it('approval_request → pending 审批卡，定格既有流式气泡', () => {
    const prev = applyOrchEvent([], { type: 'output', node_id: 'a1', speaker: 'a1', text: '调用工具' })
    const msgs = applyOrchEvent(prev, {
      type: 'approval_request',
      request_id: 'apr_1',
      node_id: 'a1',
      tool_name: 'shell_run',
      args: { cmd: 'ls' },
    })
    expect(msgs).toHaveLength(2)
    expect(msgs[0].streaming).toBe(false)
    expect(msgs[1].approval).toMatchObject({
      requestId: 'apr_1',
      toolName: 'shell_run',
      status: 'pending',
    })
  })

  it('approval_resolved: approved → 审批卡标记 approved', () => {
    let msgs = applyOrchEvent([], {
      type: 'approval_request',
      request_id: 'apr_1',
      node_id: 'a1',
      tool_name: 'shell_run',
      args: {},
    })
    msgs = applyOrchEvent(msgs, {
      type: 'approval_resolved',
      request_id: 'apr_1',
      node_id: 'a1',
      response: 'approved',
    })
    expect(msgs[0].approval).toMatchObject({ status: 'approved', sessionWide: false })
  })

  it('approval_resolved: approved_session → sessionWide=true', () => {
    let msgs = applyOrchEvent([], {
      type: 'approval_request',
      request_id: 'apr_1',
      node_id: 'a1',
      tool_name: 'shell_run',
      args: {},
    })
    msgs = applyOrchEvent(msgs, {
      type: 'approval_resolved',
      request_id: 'apr_1',
      node_id: 'a1',
      response: 'approved_session',
    })
    expect(msgs[0].approval).toMatchObject({ status: 'approved', sessionWide: true })
  })

  it('approval_resolved: denied → 审批卡标记 denied', () => {
    let msgs = applyOrchEvent([], {
      type: 'approval_request',
      request_id: 'apr_1',
      node_id: 'a1',
      tool_name: 'shell_run',
      args: {},
    })
    msgs = applyOrchEvent(msgs, {
      type: 'approval_resolved',
      request_id: 'apr_1',
      node_id: 'a1',
      response: 'denied',
    })
    expect(msgs[0].approval).toMatchObject({ status: 'denied' })
  })

  it('approval_resolved: 空 → expired', () => {
    let msgs = applyOrchEvent([], {
      type: 'approval_request',
      request_id: 'apr_1',
      node_id: 'a1',
      tool_name: 'shell_run',
      args: {},
    })
    msgs = applyOrchEvent(msgs, {
      type: 'approval_resolved',
      request_id: 'apr_1',
      node_id: 'a1',
      response: '',
    })
    expect(msgs[0].approval).toMatchObject({ status: 'expired' })
  })

  it('approval_resolved 幂等：已 resolved 不再变动', () => {
    let msgs = applyOrchEvent([], {
      type: 'approval_request',
      request_id: 'apr_1',
      node_id: 'a1',
      tool_name: 'shell_run',
      args: {},
    })
    msgs = applyOrchEvent(msgs, { type: 'approval_resolved', request_id: 'apr_1', node_id: 'a1', response: 'denied' })
    msgs = applyOrchEvent(msgs, { type: 'approval_resolved', request_id: 'apr_1', node_id: 'a1', response: 'approved' })
    expect(msgs[0].approval).toMatchObject({ status: 'denied' })
  })

  it('tool_call → 末条流式气泡标记 searching 态 + 追加 ToolCallInfo', () => {
    const prev = applyOrchEvent([], { type: 'output', node_id: 'a1', speaker: 'a1', text: '搜索中' })
    const msgs = applyOrchEvent(prev, { type: 'tool_call', node_id: 'a1', tool: 'web_search', args: { q: 'hello' } })
    expect(msgs[0].orbState).toBe('searching')
    expect(msgs[0].toolCalls).toHaveLength(1)
    expect(msgs[0].toolCalls![0]).toMatchObject({
      tool: 'web_search',
      status: 'pending',
      argsSummary: '{"q":"hello"}',
    })
  })

  it('tool_result → 恢复 working 态 + 更新 toolCall 为 done', () => {
    let msgs = applyOrchEvent([], { type: 'output', node_id: 'a1', speaker: 'a1', text: '处理' })
    msgs = applyOrchEvent(msgs, { type: 'tool_call', node_id: 'a1', tool: 'web_search', args: {} })
    expect(msgs[0].orbState).toBe('searching')
    msgs = applyOrchEvent(msgs, { type: 'tool_result', node_id: 'a1', result: { count: 3 } })
    expect(msgs[0].orbState).toBe('working')
    expect(msgs[0].toolCalls![0]).toMatchObject({ status: 'done' })
    expect(msgs[0].toolCalls![0].resultSummary).toContain('count')
  })

  it('多次 tool_call/tool_result 交替 → toolCalls 按序记录', () => {
    let msgs = applyOrchEvent([], { type: 'output', node_id: 'a1', speaker: 'a1', text: '多步' })
    msgs = applyOrchEvent(msgs, { type: 'tool_call', node_id: 'a1', tool: 'search', args: { q: 'a' } })
    msgs = applyOrchEvent(msgs, { type: 'tool_result', node_id: 'a1', result: 'r1' })
    msgs = applyOrchEvent(msgs, { type: 'tool_call', node_id: 'a1', tool: 'read_file', args: { path: '/x' } })
    msgs = applyOrchEvent(msgs, { type: 'tool_result', node_id: 'a1', result: 'r2' })
    expect(msgs[0].toolCalls).toHaveLength(2)
    expect(msgs[0].toolCalls![0]).toMatchObject({ tool: 'search', status: 'done' })
    expect(msgs[0].toolCalls![1]).toMatchObject({ tool: 'read_file', status: 'done' })
  })

  it('node_started → 末条流式气泡追加 NodeStateInfo(running)', () => {
    const prev = applyOrchEvent([], { type: 'output', node_id: 'a1', speaker: 'a1', text: '执行中' })
    const msgs = applyOrchEvent(prev, { type: 'node_started', node_id: 'agent-2' })
    expect(msgs[0].nodeStates).toHaveLength(1)
    expect(msgs[0].nodeStates![0]).toMatchObject({ nodeId: 'agent-2', status: 'running' })
  })

  it('node_done → 更新对应节点状态为 done', () => {
    let msgs = applyOrchEvent([], { type: 'output', node_id: 'a1', speaker: 'a1', text: '执行' })
    msgs = applyOrchEvent(msgs, { type: 'node_started', node_id: 'agent-2' })
    msgs = applyOrchEvent(msgs, { type: 'node_done', node_id: 'agent-2' })
    expect(msgs[0].nodeStates![0]).toMatchObject({ nodeId: 'agent-2', status: 'done' })
    expect(msgs[0].nodeStates![0].endedAt).toBeDefined()
  })

  it('node_error → 更新节点状态为 error + 生成错误气泡', () => {
    let msgs = applyOrchEvent([], { type: 'output', node_id: 'a1', speaker: 'a1', text: '执行' })
    msgs = applyOrchEvent(msgs, { type: 'node_started', node_id: 'agent-2' })
    msgs = applyOrchEvent(msgs, { type: 'node_error', node_id: 'agent-2', error: '超时' })
    expect(msgs[0].nodeStates![0]).toMatchObject({ nodeId: 'agent-2', status: 'error', error: '超时' })
    expect(msgs).toHaveLength(2)
    expect(msgs[1]).toMatchObject({ error: true, text: 'agent-2: 超时' })
  })

  it('多节点并发 → nodeStates 按序记录', () => {
    let msgs = applyOrchEvent([], { type: 'output', node_id: 'a1', speaker: 'a1', text: '多节点' })
    msgs = applyOrchEvent(msgs, { type: 'node_started', node_id: 'agent-1' })
    msgs = applyOrchEvent(msgs, { type: 'node_started', node_id: 'agent-2' })
    msgs = applyOrchEvent(msgs, { type: 'node_done', node_id: 'agent-1' })
    expect(msgs[0].nodeStates).toHaveLength(2)
    expect(msgs[0].nodeStates![0]).toMatchObject({ nodeId: 'agent-1', status: 'done' })
    expect(msgs[0].nodeStates![1]).toMatchObject({ nodeId: 'agent-2', status: 'running' })
  })

  it('thinking 事件：追加到同 speaker 末条气泡的 thinking 字段', () => {
    let msgs = applyOrchEvent([], { type: 'output', node_id: 'a1', speaker: 'a1', text: '正文' })
    msgs = applyOrchEvent(msgs, { type: 'thinking', node_id: 'a1', speaker: 'a1', text: '思考中' })
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ text: '正文', thinking: '思考中', streaming: true })
  })

  it('thinking 事件：无前置气泡 → 建只含 thinking 的占位气泡', () => {
    const msgs = applyOrchEvent([], { type: 'thinking', node_id: 'a1', speaker: 'a1', text: '先想' })
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ text: '', thinking: '先想', streaming: true })
    const out = applyOrchEvent(msgs, { type: 'output', node_id: 'a1', speaker: 'a1', text: '正文' })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ text: '正文', thinking: '先想', streaming: true })
  })

  it('output final 无前置增量气泡 → 直接建成形气泡（streaming=false）', () => {
    const msgs = applyOrchEvent([], { type: 'output', node_id: 'gc1', speaker: 'gc1', text: '完整输出', final: true })
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ text: '完整输出', streaming: false })
  })

  it('retry 事件：清空同 speaker 已发 text/thinking 增量，防重试翻倍（CODE_AUDIT 断言 1.1）', () => {
    // 第一轮流式：text + thinking 已累加
    let msgs = applyOrchEvent([], { type: 'output', node_id: 'a1', speaker: 'a1', text: '你好' })
    msgs = applyOrchEvent(msgs, { type: 'thinking', node_id: 'a1', speaker: 'a1', text: '思考' })
    expect(msgs[0]).toMatchObject({ text: '你好', thinking: '思考', streaming: true })

    // 重试：清空 text/thinking，置 retrying 态
    msgs = applyOrchEvent(msgs, {
      type: 'retry',
      node_id: 'a1',
      speaker: 'a1',
      attempt: 1,
      maxRetries: 3,
      delayMs: 1000,
      reason: 'network',
    })
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ text: '', thinking: undefined, streaming: false, retrying: '1' })
    expect(msgs[0].retryInfo).toMatchObject({ attempt: 1, maxRetries: 3, delayMs: 1000, reason: 'network' })

    // 第二轮重放：从空气泡重新累加，不翻倍
    msgs = applyOrchEvent(msgs, { type: 'output', node_id: 'a1', speaker: 'a1', text: '你好' })
    expect(msgs[0].text).toBe('你好') // 不是「你好你好」
  })

  it('retry 事件：不同 speaker 不受影响（只清当前 speaker 末条气泡）', () => {
    let msgs = applyOrchEvent([], { type: 'output', node_id: 'a1', speaker: 'a1', text: '甲' })
    // 注意：a1 已完成 streaming 后新气泡 b2
    msgs = applyOrchEvent(msgs, { type: 'output', node_id: 'b2', speaker: 'b2', text: '乙' })
    // retry 来自 a1，但末条是 b2 的气泡 → 不匹配，不应改动
    const after = applyOrchEvent(msgs, {
      type: 'retry',
      node_id: 'a1',
      speaker: 'a1',
      attempt: 1,
      maxRetries: 3,
      delayMs: 500,
      reason: 'timeout',
    })
    expect(after).toBe(msgs) // 同引用，未变
  })

  // —— 断言 1.3 修复：tool_call 按 speaker 归属，不误挂到末条别的 peer 气泡 ——
  it('tool_call 跨 speaker：A 的 toolCall 不误挂到末条 B 的流式气泡（断言 1.3）', () => {
    // 旧实现 tool_call case 只看 last.streaming 不判 speaker：A 建 streaming 气泡、
    // B 增量建 streaming 气泡（B 末条）后，A 的 tool_call 到达 → last.streaming===true
    // 属于 B → 旧逻辑把 A 的 toolCall 错挂到 B 气泡（cross-attach，确认的坏数据 bug）。
    // 修后按 node_id='A' 查 A 的气泡：A 已被 B 起泡时的 closeStreaming 定格 →
    // findStreamingBubbleForSpeaker 查不到（streaming||retrying 才可续）→ return prev，
    // A 的 toolCall 不会误挂 B。防错挂优先于防丢失（错挂会污染 B 的展示，丢失只是少了一个 chip）。
    let msgs = applyOrchEvent([], { type: 'output', node_id: 'A', speaker: 'A', text: '甲' })
    msgs = applyOrchEvent(msgs, { type: 'output', node_id: 'B', speaker: 'B', text: '乙' })
    msgs = applyOrchEvent(msgs, {
      type: 'tool_call',
      node_id: 'A',
      tool: 'web_search',
      args: { q: 'x' },
    })
    const bMsg = msgs.find((m) => m.speaker === 'B')
    // B 气泡绝不被 A 的 toolCall 污染（旧实现会 cross-attach 错挂 B）
    expect(bMsg?.toolCalls).toBeUndefined()
    expect(bMsg?.orbState).not.toBe('searching')
  })

  it('tool_call 同 speaker：A 仍 streaming 时 toolCall 落到 A 气泡', () => {
    // A 增量后直接发 tool_call（末条即 A 的 streaming 气泡）→ 落到 A 气泡，正常路径。
    let msgs = applyOrchEvent([], { type: 'output', node_id: 'A', speaker: 'A', text: '甲' })
    msgs = applyOrchEvent(msgs, {
      type: 'tool_call',
      node_id: 'A',
      tool: 'web_search',
      args: { q: 'x' },
    })
    const aMsg = msgs.find((m) => m.speaker === 'A')
    expect(aMsg?.toolCalls).toHaveLength(1)
    expect(aMsg?.toolCalls?.[0].tool).toBe('web_search')
    expect(aMsg?.orbState).toBe('searching')
  })
})
