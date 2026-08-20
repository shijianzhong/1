// —— kb_chunks FTS 重建（docs/VECTOR_KB_PLAN.md §四:146 自检）——
//
// 镜像 src/main/storage/memory/l3.ts 的 reindexL3Fts 范式：
//   事务外 select all（避免长事务持锁）、prepare 一次、事务内 DELETE+reinsert
//   （原子——重建中途崩溃不留半截索引，且批量提交快一个量级）。
//
// FTS5 双列对齐 skills_fts（fts.ts:110-118）：
//   content_tokenized = tokenizeForFts(content) 喂 MATCH（中文单字+bigram 预分词）
//   content_raw        = content 原文 UNINDEXED（LIKE 兜底精确片段用）
// tokenize='unicode61' 即可命中预分词后的连续中文。

import { getDb } from '../storage/db'
import { tokenizeForFts } from '../storage/memory/l3'

interface KbChunkRow {
  id: string
  content: string
  doc_id: string
}

/** 把 kb_chunks 全量重建进 kb_chunks_fts（迁移后/行数不一致时调用，幂等） */
export function reindexKbFts(): void {
  const db = getDb()
  const rows = db.prepare(
    'SELECT id, content, doc_id FROM kb_chunks',
  ).all() as KbChunkRow[]
  const ins = db.prepare(
    'INSERT INTO kb_chunks_fts (chunk_id, content_tokenized, content_raw, doc_id) VALUES (?, ?, ?, ?)',
  )
  db.transaction(() => {
    db.prepare('DELETE FROM kb_chunks_fts').run()
    for (const r of rows) {
      ins.run(r.id, tokenizeForFts(r.content), r.content, r.doc_id)
    }
  })()
}

/** kb_chunks 主表行数 */
export function countKbChunks(): number {
  return (getDb().prepare('SELECT COUNT(*) as c FROM kb_chunks').get() as { c: number }).c
}

/** kb_chunks_fts 索引行数 */
export function countKbFtsRows(): number {
  return (getDb().prepare('SELECT COUNT(*) as c FROM kb_chunks_fts').get() as { c: number }).c
}
