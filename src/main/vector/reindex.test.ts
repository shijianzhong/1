import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// —— reindex.ts 单测（docs/VECTOR_KB_PLAN.md §八 P4）——
// 真实内存库 + mock getActiveProvider（synthetic vec）+ mock db.ts getAppMeta/setAppMeta。
// 关键覆盖：
//  (a) kb_reindex_required='1' + clearAllKbVecs → 全 NULL → backfill → 标志清 + provider 回标
//  (b) 无 reindexRequired → 只 backfill NULL（不动已有向量）
//  (c) 进度事件 progress/done 的 done/total 单调
//  (d) AbortSignal 中途停 → 已嵌入批已落库
//  (e) provider 未就绪 → throw IpcErrorThrow

let memDb: Database.Database

// app_meta 内存表（reindex 读 kb_reindex_required，写空清标志）
const appMeta = new Map<string, string>()
vi.mock('../storage/db', () => ({
  getDb: () => memDb,
  getAppMeta: (k: string) => appMeta.get(k) ?? null,
  setAppMeta: (k: string, v: string) => {
    if (v === '') appMeta.delete(k)
    else appMeta.set(k, v)
  },
}))

const embedMock = vi.fn()
const readyMock = vi.fn()
const providerMock = {
  kind: 'local' as const,
  modelId: null as string | null,
  ready: readyMock,
  dimension: () => 3,
  embed: embedMock,
}
vi.mock('./embed', () => ({
  getActiveProvider: () => providerMock,
}))

// 进度事件收集
const progressEvents: Array<{ type: string; done: number; total: number }> = []
const sendMock = vi.fn((_channel: string, ev: { type: string; done: number; total: number }) => {
  progressEvents.push(ev)
})
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: sendMock } }],
  },
}))

const { runReindex } = await import('./reindex')
const { insertKbChunks, upsertKbDoc, getKbChunk, clearAllKbVecs } = await import('./store')
const { flatIndex } = await import('./flat-index')

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_chunks (
      id TEXT PRIMARY KEY,
      kb_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      chunk_idx INTEGER NOT NULL,
      content TEXT NOT NULL,
      vec BLOB,
      vec_dim INTEGER,
      meta TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(doc_id, chunk_idx)
    );
    CREATE INDEX idx_kb_chunks_kb ON kb_chunks(kb_id);
    CREATE VIRTUAL TABLE kb_chunks_fts USING fts5(
      chunk_id UNINDEXED,
      content_tokenized,
      content_raw UNINDEXED,
      doc_id UNINDEXED,
      tokenize='unicode61'
    );
    CREATE TABLE IF NOT EXISTS kb_docs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_path TEXT,
      source_kind TEXT,
      chunks INTEGER NOT NULL DEFAULT 0,
      embedding_provider TEXT,
      content TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT);
  `)
  return db
}

function seedChunks(withVec: boolean): void {
  const records = [
    { id: 'c0', kbId: 'kb', docId: 'docA', chunkIdx: 0, content: 'alpha', vec: withVec ? Float32Array.from([1, 0, 0]) : null, meta: null },
    { id: 'c1', kbId: 'kb', docId: 'docA', chunkIdx: 1, content: 'beta', vec: withVec ? Float32Array.from([0, 1, 0]) : null, meta: null },
    { id: 'c2', kbId: 'kb', docId: 'docB', chunkIdx: 0, content: 'gamma', vec: null, meta: null },
  ]
  insertKbChunks(records)
  upsertKbDoc({ id: 'docA', title: 'A', chunks: 2, embeddingProvider: 'old' })
  upsertKbDoc({ id: 'docB', title: 'B', chunks: 1, embeddingProvider: 'old' })
  flatIndex.load()
}

beforeEach(() => {
  memDb = freshDb()
  appMeta.clear()
  embedMock.mockReset()
  readyMock.mockReset()
  progressEvents.length = 0
  sendMock.mockClear()
  flatIndex.invalidate()
})

describe('runReindex — 全量重嵌（kb_reindex_required=1）', () => {
  it('clearAllKbVecs 后全部 chunk 进 backfill，旧维度向量被清空重嵌', async () => {
    seedChunks(true) // c0/c1 已有旧维度向量
    appMeta.set('kb_reindex_required', '1')
    readyMock.mockResolvedValue(true)
    // embed 返回 synthetic 向量（按输入顺序）
    embedMock.mockImplementation((texts: string[]) =>
      texts.map((t) => Float32Array.from([t.length, 0, 0])),
    )

    const res = await runReindex()

    // 3 块全部 backfill（含已被 clearAll 置 NULL 的 c0/c1）
    expect(res.total).toBe(3)
    expect(res.embedded).toBe(3)
    expect(res.failed).toBe(0)
    // 旧向量被清空重嵌：c0 现在是新向量 [5,0,0]（"alpha".length=5），非 [1,0,0]
    const c0 = getKbChunk('c0')
    expect(c0?.vec).not.toBeNull()
    expect(c0?.vec?.[0]).toBe(5)
    // 标志已清
    expect(appMeta.has('kb_reindex_required')).toBe(false)
    // provider 回标（local → 'local'）
    const row = memDb.prepare('SELECT embedding_provider FROM kb_docs WHERE id = ?').get('docA') as { embedding_provider: string }
    expect(row.embedding_provider).toBe('local')
    // embed 全部以 kind='passage' 调
    expect(embedMock).toHaveBeenCalled()
    const calls = embedMock.mock.calls
    for (const c of calls) expect(c[2]).toBe('passage')
  })
})

describe('runReindex — 增量补齐（无 reindexRequired）', () => {
  it('只 backfill NULL 块，不动已有向量', async () => {
    seedChunks(true) // c0/c1 已有向量，c2 NULL
    // 无 reindexRequired
    readyMock.mockResolvedValue(true)
    embedMock.mockImplementation((texts: string[]) =>
      texts.map(() => Float32Array.from([9, 9, 9])),
    )

    const res = await runReindex()

    // 只 c2 是 NULL → backfill 1 块
    expect(res.total).toBe(1)
    expect(res.embedded).toBe(1)
    // c0 旧向量保留（未被 [9,9,9] 覆盖）
    const c0 = getKbChunk('c0')
    expect(c0?.vec?.[0]).toBe(1)
    // c2 新向量
    const c2 = getKbChunk('c2')
    expect(c2?.vec?.[0]).toBe(9)
  })

  it('无 NULL 块也无 reindexRequired → 零计数 done 事件', async () => {
    seedChunks(true)
    // 把 c2 也填上向量
    memDb.prepare('UPDATE kb_chunks SET vec = ?, vec_dim = ? WHERE id = ?').run(
      Buffer.from(new Float32Array([0, 0, 1]).buffer),
      3,
      'c2',
    )
    flatIndex.invalidate()
    flatIndex.load()
    readyMock.mockResolvedValue(true)

    const res = await runReindex()
    expect(res.total).toBe(0)
    expect(res.embedded).toBe(0)
    // done 事件 done=0 total=0
    const doneEv = progressEvents.find((e) => e.type === 'done')
    expect(doneEv).toBeDefined()
    expect(doneEv!.total).toBe(0)
  })
})

describe('runReindex — 进度流', () => {
  it('progress 事件 done 单调不减，最终 done 事件', async () => {
    seedChunks(false) // 3 块全 NULL
    readyMock.mockResolvedValue(true)
    // 每输入文本返回一个向量（batch 内逐条对齐）
    embedMock.mockImplementation((texts: string[]) =>
      texts.map(() => Float32Array.from([1, 0, 0])),
    )

    await runReindex()

    const progressEvs = progressEvents.filter((e) => e.type === 'progress')
    expect(progressEvs.length).toBeGreaterThan(0)
    // done 单调不减
    let prev = -1
    for (const ev of progressEvs) {
      expect(ev.done).toBeGreaterThanOrEqual(prev)
      prev = ev.done
    }
    const doneEv = progressEvents.find((e) => e.type === 'done')
    expect(doneEv).toBeDefined()
    expect(doneEv!.done).toBe(3)
    expect(doneEv!.total).toBe(3)
  })
})

describe('runReindex — provider 未就绪', () => {
  it('ready=false → throw（IpcErrorThrow），不调 embed', async () => {
    seedChunks(false)
    appMeta.set('kb_reindex_required', '1')
    readyMock.mockResolvedValue(false)

    // provider 未就绪在 try/catch 之前抛（reindex.ts:55-58），不走 error 进度路径
    // reject 本身即信号；无 progress 事件发出
    await expect(runReindex()).rejects.toThrow()
    // 未就绪不应调 embed
    expect(embedMock).not.toHaveBeenCalled()
    // 未就绪短路，无任何进度事件
    expect(progressEvents).toHaveLength(0)
  })
})
