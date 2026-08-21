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
import { buildMatchQuery, escapeLikePattern, tokenizeForFts } from '../storage/memory/l3'

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

/**
 * KB 词法检索（docs/VECTOR_KB_PLAN.md §六:175-179）。
 * FTS5 BM25 主路 + LIKE content_raw 兜底，返回按相关度有序的 chunk_id 列表，
 * 供 searchKbHybrid 经 rankedChannel 喂 RRF 融合。
 *
 * 镜像 l3.ts searchL3 的 FTS 路范型（同 tokenizeForFts 预分词 + buildMatchQuery 构造 MATCH），
 * 但只返回 id 列表（score 交给 RRF 按 rank 统一，不在此线性加权——RRF 与分值尺度无关，
 * 对向量 cosine 与词法 BM25 公平并列）。
 *
 * 绝不抛（§六:179 降级链）：FTS5 极端字符炸语法 → try/catch 跳 FTS，退 LIKE；
 * LIKE 也空 → 返回 []。docIds 非空时限定文档范围（sharded 检索）。
 */
export function searchKbFts(query: string, limit = 10, docIds?: string[]): string[] {
  const db = getDb()
  const topK = Math.max(1, limit)
  const ftsIds: string[] = []
  const seen = new Set<string>()

  // 空查询直接返回（避免 LIKE '%%' 全表匹配 + FTS 空 MATCH 语法错）
  const trimmed = query?.trim()
  if (!trimmed) return []

  // 路 1：FTS5 BM25（rank 越负越相关，ORDER BY rank 升序即最佳在前）
  const match = buildMatchQuery(trimmed)
  if (match) {
    try {
      const sql = docIds && docIds.length > 0
        ? `SELECT chunk_id FROM kb_chunks_fts
           WHERE kb_chunks_fts MATCH ? AND doc_id IN (SELECT value FROM json_each(?))
           ORDER BY rank LIMIT ?`
        : `SELECT chunk_id FROM kb_chunks_fts WHERE kb_chunks_fts MATCH ? ORDER BY rank LIMIT ?`
      const rows = (docIds && docIds.length > 0
        ? db.prepare(sql).all(match, JSON.stringify(docIds), topK)
        : db.prepare(sql).all(match, topK)) as { chunk_id: string }[]
      for (const r of rows) {
        if (!seen.has(r.chunk_id)) {
          seen.add(r.chunk_id)
          ftsIds.push(r.chunk_id)
        }
      }
    } catch {
      // FTS5 语法异常（极端字符）→ 跳 FTS 路，退 LIKE 兜底
    }
  }

  // 路 2：LIKE content_raw 子串兜底（FTS 分词后单字过碎时的补充；转义 %/_ 防通配符全表扫）
  if (ftsIds.length < topK) {
    // 按剩余配额取（review #26）：不按 topK 全量再取一遍——否则词法路候选最多
    // ~2×topK，RRF 中词法 rank 更深、融合向词法倾斜，违背「两路同 topK」前提。
    const remaining = topK - ftsIds.length
    const esc = escapeLikePattern(trimmed)
    const likePat = `%${esc}%`
    const sql = docIds && docIds.length > 0
      ? `SELECT chunk_id FROM kb_chunks_fts
         WHERE content_raw LIKE ? ESCAPE '\\' AND doc_id IN (SELECT value FROM json_each(?))
         LIMIT ?`
      : `SELECT chunk_id FROM kb_chunks_fts WHERE content_raw LIKE ? ESCAPE '\\' LIMIT ?`
    const rows = (docIds && docIds.length > 0
      ? db.prepare(sql).all(likePat, JSON.stringify(docIds), remaining)
      : db.prepare(sql).all(likePat, remaining)) as { chunk_id: string }[]
    for (const r of rows) {
      if (!seen.has(r.chunk_id)) {
        seen.add(r.chunk_id)
        ftsIds.push(r.chunk_id)
      }
    }
  }

  return ftsIds
}
