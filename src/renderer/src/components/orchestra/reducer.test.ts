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
})
