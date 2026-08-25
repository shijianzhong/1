import { beforeEach, describe, expect, it, vi } from 'vitest'

// —— 捕获 IPC handler（与 home.chat.runEvents.test.ts 同范式）——
const { sent, handle, getClientMock, streamMock } = vi.hoisted(() => ({
  sent: [] as Array<Record<string, any>>,
  handle: vi.fn(),
  streamMock: vi.fn(),
  getClientMock: vi.fn(() => ({ stream: streamMock })),
}))

vi.mock('electron', () => ({
  ipcMain: { handle },
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: (_ch: string, ev: unknown) => sent.push(ev as Record<string, any>) } }],
  },
}))

vi.mock('../logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock('../llm/retry', () => ({ getClient: getClientMock }))

vi.mock('../storage/models', () => {
  const fakeModel = (id: string, modelId: string) => ({
    id,
    modelId,
    name: modelId,
    providerId: 'prv_1',
    isDefault: false,
  })
  return {
    getModel: vi.fn((id: string) =>
      id === 'm1' ? fakeModel('m1', 'claude-a') : id === 'm2' ? fakeModel('m2', 'claude-b') : null,
    ),
    getProvider: vi.fn(() => ({
      id: 'prv_1',
      keyId: 'k',
      baseUrl: undefined,
      authHeader: undefined,
      apiFormat: 'anthropic',
      models: {},
      enableThinking: false,
    })),
    resolveProviderCredentials: vi.fn(() => ({
      apiKey: 'k',
      baseURL: undefined,
      authHeader: undefined,
      apiFormat: 'anthropic',
      enableThinking: false,
    })),
  }
})

import { registerCompareHandlers } from './compare'

function getHandler(channel: string): (e: unknown, input: unknown) => Promise<{ ok: boolean; data?: unknown }> {
  const call = handle.mock.calls.find((c) => c[0] === channel)
  if (!call) throw new Error(`handler ${channel} not registered`)
  return call[1] as (e: unknown, input: unknown) => Promise<{ ok: boolean; data?: unknown }>
}

const waitForComplete = async (timeout = 1000): Promise<void> => {
  const start = Date.now()
  while (!sent.some((e) => e.type === 'complete')) {
    if (Date.now() - start > timeout) throw new Error('timeout waiting for complete event')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('registerCompareHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sent.length = 0
    // 每个被对比模型各自回一段带 model 标识的文本
    streamMock.mockImplementation(async (req: { model: string; onDelta?: (d: unknown) => void }) => {
      req.onDelta?.({ type: 'text', text: `resp-${req.model}` })
      return { stopReason: 'end_turn', content: [{ type: 'text', text: `resp-${req.model}` }] }
    })
  })

  it('并发 N 路：各路 delta 带 modelId，推送 start/done/complete', async () => {
    registerCompareHandlers()
    const h = getHandler('chat:compare')
    const res = await h({}, { prompt: 'hi', modelIds: ['m1', 'm2'] })
    expect(res.ok).toBe(true)
    // compareId 立即返回，不阻塞
    expect(typeof (res.data as { compareId: string }).compareId).toBe('string')

    await waitForComplete()

    // 两个模型各被独立创建 client（不同 modelId）
    expect(getClientMock).toHaveBeenCalledTimes(2)
    expect(getClientMock).toHaveBeenCalledWith('claude-a', expect.anything())
    expect(getClientMock).toHaveBeenCalledWith('claude-b', expect.anything())

    // 每路：start + delta + done 齐全，且 delta 带各自 modelId
    for (const id of ['m1', 'm2']) {
      const starts = sent.filter((e) => e.type === 'start' && e.modelId === id)
      const deltas = sent.filter((e) => e.type === 'delta' && e.modelId === id)
      const dones = sent.filter((e) => e.type === 'done' && e.modelId === id)
      expect(starts).toHaveLength(1)
      expect(starts[0].modelLabel).toBe(id === 'm1' ? 'claude-a' : 'claude-b')
      expect(deltas).toHaveLength(1)
      expect((deltas[0].delta as { text: string }).text).toBe(`resp-${id === 'm1' ? 'claude-a' : 'claude-b'}`)
      expect(dones).toHaveLength(1)
      expect((dones[0] as { textLen: number }).textLen).toBe(`resp-${id === 'm1' ? 'claude-a' : 'claude-b'}`.length)
    }
    // 一次对比收尾一个 complete
    expect(sent.filter((e) => e.type === 'complete')).toHaveLength(1)
  })

  it('错误隔离：某模型配置不存在时其余照常完成，complete 仍推送', async () => {
    registerCompareHandlers()
    const h = getHandler('chat:compare')
    await h({}, { prompt: 'hi', modelIds: ['m1', 'bad'] })
    await waitForComplete()

    // 正常路 m1：done
    expect(sent.filter((e) => e.type === 'done' && e.modelId === 'm1')).toHaveLength(1)
    // 错误路 bad：error 事件带 messageKey，且不走 getClient
    const errs = sent.filter((e) => e.type === 'error' && e.modelId === 'bad')
    expect(errs).toHaveLength(1)
    expect(errs[0].messageKey).toBe('errors:compare.model_not_found')
    expect(getClientMock).toHaveBeenCalledTimes(1) // 仅 m1
    // complete 不因单路失败而缺失
    expect(sent.filter((e) => e.type === 'complete')).toHaveLength(1)
  })
})
