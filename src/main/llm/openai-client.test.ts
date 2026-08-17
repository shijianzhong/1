import { describe, expect, it, vi } from 'vitest'
import type { LlmRequest, LlmResponse } from '@shared/types'
import { OpenAILLMClient } from './openai-client'

// —— OpenAI 协议适配器单测（P1#4）——
// 用 mock fetch 模拟 SSE 流，验证：
// 1. 请求体构建（messages/tools/system 映射）
// 2. SSE 解析与 delta 分发
// 3. tool_calls 聚合
// 4. stop_reason 映射
// 5. 错误处理

/** 构造 SSE response body（ReadableStream） */
function makeSSEResponse(
  chunks: string[],
  opts: { status?: number } = {},
): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
  const status = opts.status ?? 200
  return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } })
}

/** 构造一个 SSE data 行 */
function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

function makeReq(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 1024,
    ...overrides,
  }
}

describe('OpenAILLMClient', () => {
  describe('构造与认证', () => {
    it('默认 baseURL 和 authHeader', () => {
      const client = new OpenAILLMClient({ apiKey: 'sk-test' })
      // 不直接暴露属性，通过 fetch 调用间接验证
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        makeSSEResponse([sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n']),
      )
      client.stream(makeReq())
      const [, init] = fetchSpy.mock.calls[0]
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer sk-test' })
      fetchSpy.mockRestore()
    })

    it('x-api-key 认证头', () => {
      const client = new OpenAILLMClient({ apiKey: 'sk-test', authHeader: 'x-api-key' })
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        makeSSEResponse([sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n']),
      )
      client.stream(makeReq())
      const [, init] = fetchSpy.mock.calls[0]
      expect(init?.headers).toMatchObject({ 'x-api-key': 'sk-test' })
      expect(init?.headers).not.toHaveProperty('Authorization')
      fetchSpy.mockRestore()
    })

    it('自定义 baseURL 去尾斜杠', () => {
      const client = new OpenAILLMClient({ apiKey: 'sk-test', baseURL: 'https://api.deepseek.com/v1/' })
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        makeSSEResponse([sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n']),
      )
      client.stream(makeReq())
      const [url] = fetchSpy.mock.calls[0]
      expect(url).toBe('https://api.deepseek.com/v1/chat/completions')
      fetchSpy.mockRestore()
    })
  })

  describe('请求体构建', () => {
    it('system 放入 messages 首条', async () => {
      const client = new OpenAILLMClient({ apiKey: 'sk-test' })
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        makeSSEResponse([sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n']),
      )
      await client.stream(makeReq({ system: 'You are helpful.' }))
      const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string)
      expect(body.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' })
      fetchSpy.mockRestore()
    })

    it('tools 映射为 function 格式', async () => {
      const client = new OpenAILLMClient({ apiKey: 'sk-test' })
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        makeSSEResponse([sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n']),
      )
      await client.stream(makeReq({
        tools: [{
          name: 'get_weather',
          description: 'Get weather',
          input_schema: { type: 'object', properties: { city: { type: 'string' } } },
        }],
      }))
      const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string)
      expect(body.tools).toEqual([{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      }])
      fetchSpy.mockRestore()
    })

    it('temperature 和 stream_options', async () => {
      const client = new OpenAILLMClient({ apiKey: 'sk-test' })
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        makeSSEResponse([sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n']),
      )
      await client.stream(makeReq({ temperature: 0.7 }))
      const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string)
      expect(body.temperature).toBe(0.7)
      expect(body.stream).toBe(true)
      expect(body.stream_options).toEqual({ include_usage: true })
      fetchSpy.mockRestore()
    })

    it('tool_result 映射为独立 tool 消息', async () => {
      const client = new OpenAILLMClient({ apiKey: 'sk-test' })
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        makeSSEResponse([sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n']),
      )
      await client.stream(makeReq({
        messages: [
          { role: 'user', content: 'weather?' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'NYC' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'call_1', content: 'sunny 72F' },
            ],
          },
        ],
      }))
      const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string)
      // user → assistant(tool_calls) → tool
      expect(body.messages[1].role).toBe('assistant')
      expect(body.messages[1].tool_calls).toEqual([{
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
      }])
      expect(body.messages[2]).toEqual({
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'sunny 72F',
      })
      fetchSpy.mockRestore()
    })
  })

  describe('SSE 流式解析', () => {
    it('文本增量聚合', async () => {
      const client = new OpenAILLMClient({ apiKey: 'sk-test' })
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        makeSSEResponse([
          sseData({ choices: [{ delta: { content: 'Hello' }, finish_reason: null }] }),
          sseData({ choices: [{ delta: { content: ' world' }, finish_reason: null }] }),
          sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
          'data: [DONE]\n\n',
        ]),
      )
      const deltas: string[] = []
      const res = await client.stream(makeReq({
        onDelta: (d) => { if (d.type === 'text') deltas.push(d.text) },
      }))
      expect(deltas).toEqual(['Hello', ' world'])
      expect(res.content).toEqual([{ type: 'text', text: 'Hello world' }])
      expect(res.stopReason).toBe('end_turn')
    })

    it('reasoning_content 转 thinking delta', async () => {
      const client = new OpenAILLMClient({ apiKey: 'sk-test' })
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        makeSSEResponse([
          sseData({ choices: [{ delta: { reasoning_content: 'thinking...' }, finish_reason: null }] }),
          sseData({ choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }),
          'data: [DONE]\n\n',
        ]),
      )
      const deltas: { type: string; text: string }[] = []
      await client.stream(makeReq({
        onDelta: (d) => {
          if (d.type === 'thinking' || d.type === 'text') {
            deltas.push({ type: d.type, text: d.text })
          }
        },
      }))
      expect(deltas).toEqual([
        { type: 'thinking', text: 'thinking...' },
        { type: 'text', text: 'answer' },
      ])
    })

    it('tool_calls 增量聚合', async () => {
      const client = new OpenAILLMClient({ apiKey: 'sk-test' })
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        makeSSEResponse([
          sseData({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }] }),
          sseData({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] }, finish_reason: null }] }),
          sseData({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"NYC"}' } }] }, finish_reason: 'tool_calls' }] }),
          'data: [DONE]\n\n',
        ]),
      )
      const deltas: { type: string; id?: string; name?: string; partial_json?: string }[] = []
      const res = await client.stream(makeReq({
        onDelta: (d) => {
          if (d.type === 'tool_use_start') deltas.push({ type: d.type, id: d.id, name: d.name })
          else if (d.type === 'tool_use_delta') deltas.push({ type: d.type, id: d.id, partial_json: d.partial_json })
          else if (d.type === 'tool_use_stop') deltas.push({ type: d.type, id: d.id })
        },
      }))
      // start → delta → delta → stop
      expect(deltas[0]).toEqual({ type: 'tool_use_start', id: 'call_1', name: 'get_weather' })
      expect(deltas[1]).toEqual({ type: 'tool_use_delta', id: 'call_1', partial_json: '{"ci' })
      expect(deltas[2]).toEqual({ type: 'tool_use_delta', id: 'call_1', partial_json: 'ty":"NYC"}' })
      expect(deltas[3]).toEqual({ type: 'tool_use_stop', id: 'call_1' })
      // 最终 content 含聚合后的 tool_use
      expect(res.content).toContainEqual({
        type: 'tool_use',
        id: 'call_1',
        name: 'get_weather',
        input: { city: 'NYC' },
      })
      expect(res.stopReason).toBe('tool_use')
    })

    it('多个 tool_calls 并行聚合', async () => {
      const client = new OpenAILLMClient({ apiKey: 'sk-test' })
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        makeSSEResponse([
          sseData({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'tool_a', arguments: '{}' } }] }, finish_reason: null }] }),
          sseData({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'tool_b', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }),
          'data: [DONE]\n\n',
        ]),
      )
      const res = await client.stream(makeReq())
      const toolUses = res.content.filter((b) => b.type === 'tool_use')
      expect(toolUses).toHaveLength(2)
      expect(toolUses[0]).toMatchObject({ id: 'call_a', name: 'tool_a' })
      expect(toolUses[1]).toMatchObject({ id: 'call_b', name: 'tool_b' })
    })

    it('stop_reason 映射', async () => {
      const client = new OpenAILLMClient({ apiKey: 'sk-test' })
      const cases: Array<[string, string]> = [
        ['stop', 'end_turn'],
        ['length', 'max_tokens'],
        ['tool_calls', 'tool_use'],
        ['content_filter', 'content_filter'],
      ]
      for (const [openaiReason, expected] of cases) {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          makeSSEResponse([
            sseData({ choices: [{ delta: {}, finish_reason: openaiReason }] }),
            'data: [DONE]\n\n',
          ]),
        )
        const res = await client.stream(makeReq())
        expect(res.stopReason).toBe(expected)
        vi.restoreAllMocks()
      }
    })
  })

  describe('错误处理', () => {
    it('HTTP 错误抛异常含状态码', async () => {
      const client = new OpenAILLMClient({ apiKey: 'sk-test' })
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        makeSSEResponse(['error'], { status: 429 }),
      )
      await expect(client.stream(makeReq())).rejects.toThrow(/429/)
    })

    it('空 body 抛异常', async () => {
      const client = new OpenAILLMClient({ apiKey: 'sk-test' })
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(null, { status: 200 }),
      )
      await expect(client.stream(makeReq())).rejects.toThrow('no response body')
    })

    it('JSON 解析失败跳过不完整行', async () => {
      const client = new OpenAILLMClient({ apiKey: 'sk-test' })
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        makeSSEResponse([
          'data: {invalid json}\n\n',
          sseData({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }),
          'data: [DONE]\n\n',
        ]),
      )
      const res = await client.stream(makeReq())
      expect(res.content).toEqual([{ type: 'text', text: 'ok' }])
    })

    it('无 id 的 tool_call 用 index 生成 id', async () => {
      const client = new OpenAILLMClient({ apiKey: 'sk-test' })
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        makeSSEResponse([
          sseData({ choices: [{ delta: { tool_calls: [{ index: 0, type: 'function', function: { name: 'test', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }),
          'data: [DONE]\n\n',
        ]),
      )
      const res = await client.stream(makeReq())
      const toolUse = res.content.find((b) => b.type === 'tool_use')
      expect(toolUse).toMatchObject({ id: 'call_0', name: 'test' })
    })

    it('延迟给 id：首帧无 id 不发 start，真 id 到后补发，全程 id 一致（断言 1.2）', async () => {
      // 部分网关首帧只给 name 不给 id，后续帧才补真 id。
      // 旧行为：首帧用合成 'call_0' 发 start/delta，后续改 existing.id='toolu_real'
      // 再发 delta/stop → start/delta 与 stop id 不一致，消费者配对断裂。
      // 修后：首帧无 id 挂起不发 start/delta，真 id 到了补发 start + 累积 args，
      // 全程 tool_use_start/delta/stop 用同一真 id。
      const client = new OpenAILLMClient({ apiKey: 'sk-test' })
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        makeSSEResponse([
          // 帧 1：首现，有 name 无 id → 挂起，不发 start
          sseData({ choices: [{ delta: { tool_calls: [{ index: 0, type: 'function', function: { name: 'get_weather', arguments: '{"ci' } }] }, finish_reason: null }] }),
          // 帧 2：补真 id + 继续 args → 补发 start + 全部累积 args（'{"city":"NYC"}'）
          sseData({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'toolu_real', function: { arguments: 'ty":"NYC"}' } }] }, finish_reason: 'tool_calls' }] }),
          'data: [DONE]\n\n',
        ]),
      )
      const deltas: { type: string; id?: string; name?: string; partial_json?: string }[] = []
      const res = await client.stream(makeReq({
        onDelta: (d) => {
          if (d.type === 'tool_use_start') deltas.push({ type: d.type, id: d.id, name: d.name })
          else if (d.type === 'tool_use_delta') deltas.push({ type: d.type, id: d.id, partial_json: d.partial_json })
          else if (d.type === 'tool_use_stop') deltas.push({ type: d.type, id: d.id })
        },
      }))
      // 全程 id 一致为真 id（无合成 'call_0' 混入）
      const ids = deltas.map((d) => d.id)
      expect(ids).toEqual(['toolu_real', 'toolu_real', 'toolu_real'])
      // start 名对、delta 拼回完整 JSON、stop 配对
      expect(deltas[0]).toEqual({ type: 'tool_use_start', id: 'toolu_real', name: 'get_weather' })
      // 挂起期间累积的 args 在补发 start 后一次性发完整串
      expect(deltas[1]).toEqual({ type: 'tool_use_delta', id: 'toolu_real', partial_json: '{"city":"NYC"}' })
      expect(deltas[2]).toEqual({ type: 'tool_use_stop', id: 'toolu_real' })
      // 最终 content 用真 id
      expect(res.content).toContainEqual({
        type: 'tool_use',
        id: 'toolu_real',
        name: 'get_weather',
        input: { city: 'NYC' },
      })
    })
  })

  describe('signal 透传', () => {
    it('fetch 接收 AbortSignal', async () => {
      const client = new OpenAILLMClient({ apiKey: 'sk-test' })
      let capturedInit: RequestInit | undefined
      vi.spyOn(globalThis, 'fetch').mockImplementation((_url: string | URL | Request, init?: RequestInit) => {
        capturedInit = init
        return Promise.resolve(
          makeSSEResponse([sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n']),
        )
      })
      const controller = new AbortController()
      await client.stream(makeReq({ signal: controller.signal }))
      expect(capturedInit?.signal).toBe(controller.signal)
      vi.restoreAllMocks()
    })
  })
})
