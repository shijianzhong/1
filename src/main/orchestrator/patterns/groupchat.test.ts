import { describe, expect, it, vi } from 'vitest'
import type { OrchMessage, WorkflowContext } from '@shared/types'
import type { Agent } from '../agent'
import {
  GroupChatExecutor,
  applyFairnessPatch,
  dedupMessages,
  extractManagerOutput,
  stripToolBlocks,
} from './groupchat'

// —— GroupChat 四 patch 单测（§10.1 + §三之三 G + 铁律13）——
// 纯函数测试；broadcast/round_robin 运行时走 E2E。

describe('GroupChat 四 patch', () => {
  it('dedup_patch：按 role+author+content 去重', () => {
    const msgs: OrchMessage[] = [
      { role: 'user', author: 'A', content: 'hi' },
      { role: 'assistant', author: 'B', content: 'hello' },
      { role: 'user', author: 'A', content: 'hi' }, // 重复
      { role: 'assistant', author: 'B', content: 'hello' }, // 重复
    ]
    const out = dedupMessages(msgs)
    expect(out.length).toBe(2)
  })

  it('dedup_patch：不同 author 不去重', () => {
    const msgs: OrchMessage[] = [
      { role: 'assistant', author: 'A', content: 'hi' },
      { role: 'assistant', author: 'B', content: 'hi' },
    ]
    expect(dedupMessages(msgs).length).toBe(2)
  })

  it('stripToolBlocks：剥 tool/function_result 块（铁律14 治 2013）', () => {
    const msgs: OrchMessage[] = [
      { role: 'user', content: '问题' },
      { role: 'tool', content: 'tool_result' },
      { role: 'user', content: 'func_result', isFunctionResult: true },
      { role: 'assistant', author: 'A', content: '回答' },
    ]
    const out = stripToolBlocks(msgs)
    expect(out.length).toBe(2)
    expect(out.some((m) => m.content === 'tool_result')).toBe(false)
    expect(out.some((m) => m.content === 'func_result')).toBe(false)
  })

  it('extractManagerOutput：直接 JSON', () => {
    const out = extractManagerOutput('{"terminate":true,"next_speaker":"A"}')
    expect(out).toEqual({ terminate: true, next_speaker: 'A' })
  })

  it('extractManagerOutput：剥 ```json 围栏', () => {
    const raw = '```json\n{"terminate":false,"next_speaker":"B"}\n```'
    const out = extractManagerOutput(raw) as { terminate: boolean }
    expect(out.terminate).toBe(false)
  })

  it('extractManagerOutput：正则兜底（无围栏无 JSON）', () => {
    const raw = '我认为 next_speaker 是 A {"terminate":true,"next_speaker":"A"} 结束'
    const out = extractManagerOutput(raw)
    expect(out).not.toBeNull()
  })

  it('extractManagerOutput：完全无法解析返回 null', () => {
    expect(extractManagerOutput('纯文本无 JSON')).toBeNull()
  })

  it('applyFairnessPatch：terminate=true 但有未发言者 → 强制 false', () => {
    const out = applyFairnessPatch(
      { terminate: true, next_speaker: 'A' },
      ['A', 'B', 'C'],
      new Set(['A']), // B C 未发言
    )
    expect(out.terminate).toBe(false)
    expect(out.next_speaker).toBe('B')
  })

  it('applyFairnessPatch：terminate=true 且全员已发言 → 保持 true', () => {
    const out = applyFairnessPatch(
      { terminate: true, next_speaker: 'A' },
      ['A', 'B'],
      new Set(['A', 'B']),
    )
    expect(out.terminate).toBe(true)
  })

  it('applyFairnessPatch：terminate=false 不干预', () => {
    const out = applyFairnessPatch(
      { terminate: false, next_speaker: 'A' },
      ['A', 'B'],
      new Set(['A']),
    )
    expect(out.terminate).toBe(false)
  })
})

// —— GroupChat manager 结构化输出接线（铁律19）——

function mockCtx(): WorkflowContext & { sent: Array<{ data: unknown; target?: string }>; outputs: string[] } {
  const sent: Array<{ data: unknown; target?: string }> = []
  const outputs: string[] = []
  return {
    sent,
    outputs,
    send_message: vi.fn(async (data: unknown, target?: string) => {
      sent.push({ data, target })
    }),
    yield_output: vi.fn(async (data: unknown) => {
      outputs.push(typeof data === 'string' ? data : JSON.stringify(data))
    }),
    add_event: vi.fn(async () => {}),
    get_source_executor_id: () => 'gc',
  }
}

describe('GroupChat manager 结构化输出', () => {
  it('manager terminate=true + final_message → 直接输出 final_message', async () => {
    const orchestrator = {
      run: vi.fn(async () => ({
        finalText: '{"terminate":true,"reason":"done","next_speaker":"","final_message":"最终答复"}',
      })),
    } as unknown as Agent

    const gc = new GroupChatExecutor({
      id: 'gc',
      participantIds: ['A', 'B'],
      selectorMode: 'manager',
      maxRounds: 6,
      orchestrator,
    })
    gc.cache.push({ role: 'user', content: '问题' })
    const ctx = mockCtx()
    const stream = gc.handle(
      { messages: [{ role: 'user', content: '问题' }], shouldRespond: true },
      ctx,
    )
    for await (const _ of stream) void _

    expect(ctx.outputs).toEqual(['最终答复'])
    expect(ctx.sent.length).toBe(0) // 不再 broadcast
  })

  it('manager terminate=false → broadcast + 定向 next_speaker', async () => {
    const orchestrator = {
      run: vi.fn(async () => ({
        finalText: '{"terminate":false,"reason":"need more","next_speaker":"B","final_message":""}',
      })),
    } as unknown as Agent

    const gc = new GroupChatExecutor({
      id: 'gc',
      participantIds: ['A', 'B'],
      selectorMode: 'manager',
      maxRounds: 6,
      orchestrator,
    })
    gc.cache.push({ role: 'user', content: '问题' })
    const ctx = mockCtx()
    const stream = gc.handle(
      { messages: [{ role: 'user', content: '问题' }], shouldRespond: true },
      ctx,
    )
    for await (const _ of stream) void _

    // broadcast 给 A（shouldRespond=false）+ 定向 B（shouldRespond=true）
    expect(ctx.sent.length).toBe(2)
    const broadcast = ctx.sent.find((s) => s.target === 'A')
    const directed = ctx.sent.find((s) => s.target === 'B')
    expect((broadcast?.data as { shouldRespond?: boolean }).shouldRespond).toBe(false)
    expect((directed?.data as { shouldRespond?: boolean }).shouldRespond).toBe(true)
    // 定向请求带完整历史（cache_patch）
    expect((directed?.data as { content: string }).content).toContain('【群聊历史】')
  })

  it('manager 解析失败 → 降级 round_robin', async () => {
    const orchestrator = {
      run: vi.fn(async () => ({ finalText: '纯文本无法解析' })),
    } as unknown as Agent

    const gc = new GroupChatExecutor({
      id: 'gc',
      participantIds: ['A', 'B'],
      selectorMode: 'manager',
      maxRounds: 6,
      orchestrator,
    })
    gc.cache.push({ role: 'user', content: '问题' })
    const ctx = mockCtx()
    const stream = gc.handle(
      { messages: [{ role: 'user', content: '问题' }], shouldRespond: true },
      ctx,
    )
    for await (const _ of stream) void _

    // round_robin 第 1 轮选 A（round=1 % 2 = 1 → B？round 已自增到 1，1 % 2 = 1 → B）
    // 关键是：不卡死，有 broadcast + 定向
    expect(ctx.sent.length).toBe(2)
    expect(ctx.outputs.length).toBe(0)
  })

  it('round_robin 模式不调 orchestrator', async () => {
    const orchestrator = { run: vi.fn() } as unknown as Agent
    const gc = new GroupChatExecutor({
      id: 'gc',
      participantIds: ['A', 'B'],
      selectorMode: 'round_robin',
      maxRounds: 6,
      orchestrator,
    })
    gc.cache.push({ role: 'user', content: '问题' })
    const ctx = mockCtx()
    const stream = gc.handle(
      { messages: [{ role: 'user', content: '问题' }], shouldRespond: true },
      ctx,
    )
    for await (const _ of stream) void _

    expect((orchestrator.run as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })
})
