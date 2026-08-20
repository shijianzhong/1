import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

// v10 迁移 SQL（与 src/main/storage/db.ts v10 一字一致，复制而非 import 避免拉起整个
// getDb 依赖链——迁移测试只验 DDL 正确性，与 db.ts 单测同范式 v6.test.ts）
const V10_SQL = `
  CREATE TABLE IF NOT EXISTS kb_chunks (
    id          TEXT PRIMARY KEY,
    kb_id       TEXT NOT NULL,
    doc_id      TEXT NOT NULL,
    chunk_idx   INTEGER NOT NULL,
    content     TEXT NOT NULL,
    vec         BLOB,
    vec_dim     INTEGER,
    meta        TEXT,
    created_at  INTEGER NOT NULL,
    UNIQUE(doc_id, chunk_idx)
  );
  CREATE INDEX IF NOT EXISTS idx_kb_chunks_kb ON kb_chunks(kb_id);

  CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
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
`

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`)
  db.exec(V10_SQL)
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(10)
  return db
}

describe('kb v10 migration', () => {
  it('三表存在 + 列齐全', () => {
    const db = freshDb()
    const chunks = (db.prepare('PRAGMA table_info(kb_chunks)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(chunks).toContain('id')
    expect(chunks).toContain('vec')
    expect(chunks).toContain('vec_dim')
    expect(chunks).toContain('meta')
    expect(chunks).toContain('chunk_idx')

    const docs = (db.prepare('PRAGMA table_info(kb_docs)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(docs).toContain('embedding_provider')
    expect(docs).toContain('chunks')

    // FTS 表存在 + 可查
    const ftsCols = (db.prepare('PRAGMA table_info(kb_chunks_fts)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(ftsCols).toContain('content_tokenized')
    expect(ftsCols).toContain('content_raw')
    db.close()
  })

  it('UNIQUE(doc_id, chunk_idx) 约束：重复 chunk_idx 拒绝', () => {
    const db = freshDb()
    const ins = db.prepare(
      'INSERT INTO kb_chunks (id, kb_id, doc_id, chunk_idx, content, created_at) VALUES (?,?,?,?,?,?)',
    )
    ins.run('kb_1', 'kbid', 'doc1', 0, 'a', 1)
    expect(() => ins.run('kb_2', 'kbid', 'doc1', 0, 'b', 1)).toThrow()
    // 同 doc_id 不同 chunk_idx 允许
    ins.run('kb_3', 'kbid', 'doc1', 1, 'c', 1)
    db.close()
  })

  it('双列 FTS 可 MATCH 命中 tokenized', () => {
    const db = freshDb()
    db.prepare(
      'INSERT INTO kb_chunks_fts (chunk_id, content_tokenized, content_raw, doc_id) VALUES (?,?,?,?)',
    ).run('kb_1', '你好 世界', '你好世界', 'doc1')
    // MATCH 走 content_tokenized
    const hit = db
      .prepare("SELECT chunk_id FROM kb_chunks_fts WHERE kb_chunks_fts MATCH '你好'")
      .get() as { chunk_id: string } | undefined
    expect(hit?.chunk_id).toBe('kb_1')
    db.close()
  })

  it('vec BLOB 可为 NULL（离线块照常落库）', () => {
    const db = freshDb()
    db.prepare(
      'INSERT INTO kb_chunks (id, kb_id, doc_id, chunk_idx, content, vec, vec_dim, created_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run('kb_1', 'kbid', 'doc1', 0, '离线内容', null, null, 1)
    const row = db.prepare('SELECT vec, vec_dim FROM kb_chunks WHERE id = ?').get('kb_1') as {
      vec: Buffer | null
      vec_dim: number | null
    }
    expect(row.vec).toBeNull()
    expect(row.vec_dim).toBeNull()
    db.close()
  })
})
