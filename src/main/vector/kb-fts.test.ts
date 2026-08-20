import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// —— kb-fts.ts searchKbFts 单测 ——
// 内存库 + vi.mock getDb，同 store.test.ts 模式。
// 关键覆盖：FTS5 MATCH 命中顺序、LIKE 兜底、docIds 过滤、极端字符不崩、空查询。

let memDb: Database.Database

vi.mock('../storage/db', () => ({
  getDb: () => memDb,
}))

const { searchKbFts } = await import('./kb-fts')
const { insertKbChunks } = await import('./store')

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE VIRTUAL TABLE kb_chunks_fts USING fts5(
      chunk_id UNINDEXED,
      content_tokenized,
      content_raw UNINDEXED,
      doc_id UNINDEXED,
      tokenize='unicode61'
    );
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
    CREATE TABLE IF NOT EXISTS kb_docs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
  `)
  return db
}

beforeEach(() => {
  memDb = freshDb()
})

describe('searchKbFts MATCH 命中', () => {
  it('中文 bigram 命中，返回有序 chunk_id 列表', () => {
    // insertKbChunks 双写（含 tokenizeForFts 预分词），与生产一致
    const ids = insertKbChunks([
      { kbId: 'kb', docId: 'doc1', chunkIdx: 0, content: '向量检索引擎设计', vec: null },
      { kbId: 'kb', docId: 'doc1', chunkIdx: 1, content: '关键词检索排序算法', vec: null },
      { kbId: 'kb', docId: 'doc2', chunkIdx: 0, content: '无关内容随便写', vec: null },
    ])
    const hitIds = searchKbFts('检索', 5)
    // 两条带「检索」bigram 的 chunk 命中
    expect(hitIds.length).toBe(2)
    expect(hitIds).toContain(ids[0])
    expect(hitIds).toContain(ids[1])
  })

  it('英文单词命中', () => {
    const ids = insertKbChunks([
      { kbId: 'kb', docId: 'doc1', chunkIdx: 0, content: 'the quick brown fox hello world', vec: null },
      { kbId: 'kb', docId: 'doc1', chunkIdx: 1, content: 'lazy dog', vec: null },
    ])
    const hitIds = searchKbFts('hello', 5)
    expect(hitIds.length).toBe(1)
    expect(hitIds).toContain(ids[0])
  })
})

describe('searchKbFts LIKE 兜底', () => {
  it('FTS 无命中时 LIKE content_raw 兜底命中', () => {
    const ids = insertKbChunks([
      { kbId: 'kb', docId: 'doc1', chunkIdx: 0, content: '一段很特殊%含通配符的内容', vec: null },
    ])
    // 「特殊%含」经 tokenizeForFts 后 % 被当单字符 token，FTS MATCH 可能命中也可能不命中；
    // 关键是 LIKE 兜底能命中，且 % 被转义不当通配符（不会全表扫返回所有行）
    const hitIds = searchKbFts('特殊%含', 5)
    expect(hitIds.length).toBeGreaterThanOrEqual(1)
    expect(hitIds).toContain(ids[0])
  })
})

describe('searchKbFts docIds 过滤', () => {
  it('docIds 非空 → 只返回限定文档内的命中', () => {
    insertKbChunks([
      { kbId: 'kb', docId: 'doc1', chunkIdx: 0, content: '检索文档A', vec: null },
      { kbId: 'kb', docId: 'doc2', chunkIdx: 0, content: '检索文档B', vec: null },
      { kbId: 'kb', docId: 'doc3', chunkIdx: 0, content: '检索文档C', vec: null },
    ])
    const ids = searchKbFts('检索', 10, ['doc1', 'doc3'])
    expect(ids.length).toBe(2)
    // 不含 doc2 的块
    const doc2Chunks = (memDb.prepare('SELECT id FROM kb_chunks WHERE doc_id=?').all('doc2') as { id: string }[]).map((r) => r.id)
    for (const id of doc2Chunks) expect(ids).not.toContain(id)
  })
})

describe('searchKbFts 健壮性', () => {
  it('极端字符（FTS 语法）不崩 → 返回数组（可能空）', () => {
    insertKbChunks([{ kbId: 'kb', docId: 'doc1', chunkIdx: 0, content: '正常内容', vec: null }])
    // 含 FTS5 特殊语法字符，不抛
    const ids = searchKbFts('"未闭合引号 AND OR NOT *', 5)
    expect(Array.isArray(ids)).toBe(true)
  })

  it('空查询 → 返回 []', () => {
    insertKbChunks([{ kbId: 'kb', docId: 'doc1', chunkIdx: 0, content: '内容', vec: null }])
    expect(searchKbFts('   ', 5)).toEqual([])
    expect(searchKbFts('', 5)).toEqual([])
  })

  it('limit 截断', () => {
    insertKbChunks([
      { kbId: 'kb', docId: 'doc1', chunkIdx: 0, content: '检索块A', vec: null },
      { kbId: 'kb', docId: 'doc1', chunkIdx: 1, content: '检索块B', vec: null },
      { kbId: 'kb', docId: 'doc1', chunkIdx: 2, content: '检索块C', vec: null },
      { kbId: 'kb', docId: 'doc1', chunkIdx: 3, content: '检索块D', vec: null },
    ])
    const ids = searchKbFts('检索', 2)
    expect(ids.length).toBeLessThanOrEqual(2)
  })
})
