import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// —— store.ts 单测（内存库 + vi.mock getDb，同 runEvents.test.ts 模式）——
// 关键覆盖：Float32Array↔BLOB 往返（byteOffset）、双写 FTS、vec=NULL 离线块、
// UNIQUE 约束幂等重摄取、内存索引失效。

let memDb: Database.Database

vi.mock('../storage/db', () => ({
  getDb: () => memDb,
}))

const { insertKbChunks, getKbChunk, blobToVec, vecToBlob, deleteKbDoc } = await import(
  './store'
)

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
      created_at INTEGER,
      updated_at INTEGER
    );
  `)
  return db
}

beforeEach(() => {
  memDb = freshDb()
})

describe('vecToBlob / blobToVec 往返', () => {
  it('独立 Float32Array 往返无损', () => {
    const v = Float32Array.from([0.1, 0.2, 0.3, 0.4])
    const blob = vecToBlob(v)
    const back = blobToVec(blob, 4)
    expect(back.length).toBe(4)
    expect(Array.from(back)).toEqual([
      expect.closeTo(0.1, 5),
      expect.closeTo(0.2, 5),
      expect.closeTo(0.3, 5),
      expect.closeTo(0.4, 5),
    ])
  })

  it('byteOffset 非零的 Float32Array 视图不泄漏前段（§五测试目标）', () => {
    // 构造一个 8 元素的 buffer，取后 4 元素作视图（byteOffset=16）
    const full = new Float32Array([0, 0, 0, 0, 0.5, 0.6, 0.7, 0.8])
    const view = full.subarray(4) // byteOffset = 4*4 = 16
    expect(view.byteOffset).toBe(16)
    const blob = vecToBlob(view)
    const back = blobToVec(blob, 4)
    expect(back.length).toBe(4)
    // 必须是后 4 个，不是前 4 个（0,0,0,0）
    expect(Array.from(back)).toEqual([
      expect.closeTo(0.5, 5),
      expect.closeTo(0.6, 5),
      expect.closeTo(0.7, 5),
      expect.closeTo(0.8, 5),
    ])
  })
})

describe('insertKbChunks 双写 + getKbChunk', () => {
  it('2 条带 vec + 1 条 vec=null 全部落库 + FTS 命中', () => {
    const ids = insertKbChunks([
      {
        kbId: 'kbid',
        docId: 'doc1',
        chunkIdx: 0,
        content: '你好世界 hello',
        vec: Float32Array.from([0.1, 0.2, 0.3]),
        meta: '{"title":"t"}',
      },
      {
        kbId: 'kbid',
        docId: 'doc1',
        chunkIdx: 1,
        content: 'second chunk here',
        vec: Float32Array.from([0.4, 0.5, 0.6]),
      },
      {
        kbId: 'kbid',
        docId: 'doc1',
        chunkIdx: 2,
        content: '离线块无向量',
        vec: null,
      },
    ])
    expect(ids.length).toBe(3)

    // kb_chunks 主表 3 条
    const cnt = (memDb.prepare('SELECT COUNT(*) as c FROM kb_chunks').get() as { c: number }).c
    expect(cnt).toBe(3)

    // FTS 3 条 + MATCH 命中
    const ftsCnt = (memDb.prepare('SELECT COUNT(*) as c FROM kb_chunks_fts').get() as { c: number })
      .c
    expect(ftsCnt).toBe(3)
    const hit = memDb
      .prepare("SELECT chunk_id FROM kb_chunks_fts WHERE kb_chunks_fts MATCH '你好'")
      .get() as { chunk_id: string } | undefined
    expect(hit?.chunk_id).toBe(ids[0])

    // getKbChunk 回读 vec 往返
    const c0 = getKbChunk(ids[0])
    expect(c0?.vec?.length).toBe(3)
    expect(Array.from(c0!.vec!)).toEqual([
      expect.closeTo(0.1, 5),
      expect.closeTo(0.2, 5),
      expect.closeTo(0.3, 5),
    ])

    // vec=null 块回读 vec 为 null
    const c2 = getKbChunk(ids[2])
    expect(c2?.vec).toBeNull()
  })

  it('同 doc_id 重摄取幂等：先删旧块再写新', () => {
    insertKbChunks([
      { kbId: 'kbid', docId: 'doc1', chunkIdx: 0, content: 'old A' },
      { kbId: 'kbid', docId: 'doc1', chunkIdx: 1, content: 'old B' },
    ])
    expect((memDb.prepare('SELECT COUNT(*) as c FROM kb_chunks WHERE doc_id=?').get('doc1') as { c: number }).c).toBe(2)

    // 重摄取同 doc_id 只 1 条 → 旧 2 条删，新 1 条
    insertKbChunks([{ kbId: 'kbid', docId: 'doc1', chunkIdx: 0, content: 'new only' }])
    const cnt = (memDb.prepare('SELECT COUNT(*) as c FROM kb_chunks WHERE doc_id=?').get('doc1') as { c: number }).c
    expect(cnt).toBe(1)
    const ftsCnt = (memDb.prepare('SELECT COUNT(*) as c FROM kb_chunks_fts WHERE doc_id=?').get('doc1') as { c: number }).c
    expect(ftsCnt).toBe(1)
  })

  it('deleteKbDoc 删主表 + FTS + doc 元信息', () => {
    insertKbChunks([{ kbId: 'kbid', docId: 'doc1', chunkIdx: 0, content: 'x' }])
    deleteKbDoc('doc1')
    expect((memDb.prepare('SELECT COUNT(*) as c FROM kb_chunks').get() as { c: number }).c).toBe(0)
    expect((memDb.prepare('SELECT COUNT(*) as c FROM kb_chunks_fts').get() as { c: number }).c).toBe(0)
  })
})
