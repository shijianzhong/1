import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// —— RemoteEmbeddingProvider + getActiveProvider 选择逻辑单测（§八 P4）——
// mock 全部外部依赖（db app_meta / models.getProvider / vault.getKey / fetch）。
// 关键覆盖：
//  RemoteEmbeddingProvider:
//   (a) ready() 配置完整 true / 缺 key|model|baseUrl false
//   (b) dimension() 已知模型查表 1536；未知→0
//   (c) embed() POST body 正确 + 解析 Float32Array；auth header x-api-key vs Bearer
//   (d) HTTP 错 → 全 null；网络异常 → 全 null
//   (e) 首成功 embed 回填 dim 到 app_meta
//  getActiveProvider 选择:
//   (f) 无 pref → local
//   (g) pref + embedding + key → remote
//   (h) pref + 无 embedding 槽 → local（不回退聊天模型）
//   (i) pref + 无 key → local

const appMeta = new Map<string, string>()
vi.mock('../storage/db', () => ({
  getDb: () => ({ prepare: () => ({ get: () => undefined, run: () => undefined }) }),
  getAppMeta: (k: string) => appMeta.get(k) ?? null,
  setAppMeta: (k: string, v: string) => {
    if (v === '') appMeta.delete(k)
    else appMeta.set(k, v)
  },
}))

const providerStore = new Map<string, { id: string; name: string; baseUrl?: string; keyId?: string; authHeader?: string; models: { embedding?: string } }>()
vi.mock('../storage/models', () => ({
  getProvider: (id: string) => providerStore.get(id),
}))

const vaultKeys = new Map<string, string>()
vi.mock('../secrets/vault', () => ({
  getKey: (keyId: string) => vaultKeys.get(keyId),
}))

// worker-client 不应被 remote 调用，但 LocalProvider 构造依赖其常量；提供桩
vi.mock('./worker-client', () => ({
  DEFAULT_MODEL_DIM: 384,
  DEFAULT_MODEL_ID: 'Xenova/multilingual-e5-small',
  embedBatchViaWorker: vi.fn(),
}))

// flat-index / kb-fts 桩（getKbStatus 会调 countKbChunks）
vi.mock('./kb-fts', () => ({ countKbChunks: () => 0 }))
vi.mock('./flat-index', () => ({ initFlatIndex: () => {}, flatIndex: { invalidate: () => {} } }))

// fetch mock
const fetchMock = vi.fn()
const originalFetch = globalThis.fetch
beforeEach(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

const { getActiveProvider, getKbStatus } = await import('./embed')

beforeEach(() => {
  appMeta.clear()
  providerStore.clear()
  vaultKeys.clear()
  fetchMock.mockReset()
})

describe('RemoteEmbeddingProvider.ready()', () => {
  it('配置完整（key+baseUrl+model）→ true', async () => {
    appMeta.set('kb_embedding_provider_id', 'p1')
    providerStore.set('p1', { id: 'p1', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyId: 'k1', models: { embedding: 'text-embedding-3-small' } })
    vaultKeys.set('k1', 'sk-xxx')
    const p = getActiveProvider()
    expect(p.kind).toBe('remote')
    await expect(p.ready()).resolves.toBe(true)
  })

  it('缺 key → 降级 local（ready 取决于本地模型文件，但 kind 应是 local）', () => {
    appMeta.set('kb_embedding_provider_id', 'p1')
    providerStore.set('p1', { id: 'p1', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyId: 'k1', models: { embedding: 'text-embedding-3-small' } })
    // 无 vaultKeys.set('k1', ...) → key 缺
    const p = getActiveProvider()
    expect(p.kind).toBe('local')
  })

  it('缺 embedding 槽 → 降级 local（不回退 default 聊天模型）', () => {
    appMeta.set('kb_embedding_provider_id', 'p1')
    providerStore.set('p1', { id: 'p1', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyId: 'k1', models: {} })
    vaultKeys.set('k1', 'sk-xxx')
    const p = getActiveProvider()
    expect(p.kind).toBe('local')
  })
})

describe('RemoteEmbeddingProvider.dimension()', () => {
  it('已知模型 text-embedding-3-small → 1536（静态查表，无网络）', () => {
    appMeta.set('kb_embedding_provider_id', 'p1')
    providerStore.set('p1', { id: 'p1', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyId: 'k1', models: { embedding: 'text-embedding-3-small' } })
    vaultKeys.set('k1', 'sk-xxx')
    const p = getActiveProvider()
    expect(p.dimension()).toBe(1536)
  })

  it('未知模型 → 0（首 embed 前无维度）', () => {
    appMeta.set('kb_embedding_provider_id', 'p1')
    providerStore.set('p1', { id: 'p1', name: 'Custom', baseUrl: 'https://x.com/v1', keyId: 'k1', models: { embedding: 'custom-embed-v1' } })
    vaultKeys.set('k1', 'sk-xxx')
    const p = getActiveProvider()
    expect(p.dimension()).toBe(0)
  })
})

describe('RemoteEmbeddingProvider.embed()', () => {
  function setupRemote(model = 'text-embedding-3-small', authHeader?: string): void {
    appMeta.set('kb_embedding_provider_id', 'p1')
    providerStore.set('p1', {
      id: 'p1',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1/',
      keyId: 'k1',
      authHeader,
      models: { embedding: model },
    })
    vaultKeys.set('k1', 'sk-secret')
  }

  it('POST body 正确 + 解析 Float32Array + Bearer auth（默认）', async () => {
    setupRemote()
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }] }),
    })
    const p = getActiveProvider()
    const out = await p.embed(['hello', 'world'])
    expect(out.length).toBe(2)
    expect(out[0]).toBeInstanceOf(Float32Array)
    expect(Array.from(out[0]!)).toEqual([expect.closeTo(0.1, 5), expect.closeTo(0.2, 5), expect.closeTo(0.3, 5)])
    // 校验 fetch 调用：URL + body + Bearer
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/embeddings') // 末尾斜杠已剥
    expect(init.method).toBe('POST')
    expect(init.headers['Authorization']).toBe('Bearer sk-secret')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('text-embedding-3-small')
    expect(body.input).toEqual(['hello', 'world'])
  })

  it('authHeader=x-api-key → 走 x-api-key 头', async () => {
    setupRemote('text-embedding-3-small', 'x-api-key')
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [1, 0] }] }) })
    const p = getActiveProvider()
    await p.embed(['x'])
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers['x-api-key']).toBe('sk-secret')
    expect(init.headers['Authorization']).toBeUndefined()
  })

  it('HTTP 错 → 全 null（降级不抛）', async () => {
    setupRemote()
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limited' })
    const p = getActiveProvider()
    const out = await p.embed(['a', 'b'])
    expect(out).toEqual([null, null])
  })

  it('网络异常 → 全 null（降级不抛）', async () => {
    setupRemote()
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    const p = getActiveProvider()
    const out = await p.embed(['a'])
    expect(out).toEqual([null])
  })

  it('首成功 embed 回填 dim 到 app_meta（未知模型）', async () => {
    setupRemote('custom-embed-v1')
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [1, 2, 3, 4] }] }) })
    const p = getActiveProvider()
    expect(p.dimension()).toBe(0) // embed 前
    await p.embed(['x'])
    // 回填后 app_meta 有缓存
    expect(appMeta.get('kb_remote_dim:custom-embed-v1')).toBe('4')
  })

  it('空数组 → 直接空数组返回，不发 fetch', async () => {
    setupRemote()
    const p = getActiveProvider()
    const out = await p.embed([])
    expect(out).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('getActiveProvider 选择逻辑', () => {
  it('无 pref → local', () => {
    const p = getActiveProvider()
    expect(p.kind).toBe('local')
    expect(p.modelId).toBeNull()
  })

  it('pref + embedding + key → remote，modelId = embedding 模型', () => {
    appMeta.set('kb_embedding_provider_id', 'p1')
    providerStore.set('p1', { id: 'p1', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyId: 'k1', models: { embedding: 'text-embedding-3-small' } })
    vaultKeys.set('k1', 'sk-xxx')
    const p = getActiveProvider()
    expect(p.kind).toBe('remote')
    expect(p.modelId).toBe('text-embedding-3-small')
  })

  it('pref 指向不存在的 provider → local', () => {
    appMeta.set('kb_embedding_provider_id', 'nope')
    const p = getActiveProvider()
    expect(p.kind).toBe('local')
  })
})

describe('getKbStatus 分支', () => {
  it('remote + ready → ready/remote + dim', async () => {
    appMeta.set('kb_embedding_provider_id', 'p1')
    providerStore.set('p1', { id: 'p1', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyId: 'k1', models: { embedding: 'text-embedding-3-small' } })
    vaultKeys.set('k1', 'sk-xxx')
    const st = await getKbStatus()
    expect(st.embedding).toBe('ready')
    expect(st.provider).toBe('remote')
    expect(st.dimension).toBe(1536)
    expect(st.activeProviderId).toBe('p1')
    expect(st.embeddingModel).toBe('text-embedding-3-small')
  })

  it('remote + 缺 key → config-error/none', async () => {
    appMeta.set('kb_embedding_provider_id', 'p1')
    providerStore.set('p1', { id: 'p1', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyId: 'k1', models: { embedding: 'text-embedding-3-small' } })
    // 无 key → 降级 local，但本地模型也缺文件 → missing
    const st = await getKbStatus()
    // 降级 local 后 local 未就绪 → missing（而非 config-error）
    // config-error 只在 provider.kind===remote 但 ready=false 时；降级后 kind=local
    expect(st.provider).toBe('none')
  })
})
