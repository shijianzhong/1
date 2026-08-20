// —— VectorStore 抽象 + SQLite 持久化（docs/VECTOR_KB_PLAN.md §三、§四）——
//
// 首期用「SQLite 主表 kb_chunks + 内存 FlatIndex」。向量以 BLOB 存主表（Float32Array
// 归一化后逐元素 4 字节 little-endian），内存索引在 flat-index.ts 加速 cosine 点积。
//
// 抽象按「每实体一索引」设计（§四:147）：P0 只有 kb_chunks；P3 扩 'memory_l3'|'skills'
// 时接口不变（各自内存索引解耦，不 keyed 进 kb_chunks——L3 是 KV 语义、skills 是元数据
// 语义，与文档分块实体不同构）。
//
// vec 可为 NULL（§四:144）：模型未就绪/离线时新块照常落库（content + FTS），仅 vec 空；
// 模型就绪后 kb:reindex 补向量。hybrid 检索时 NULL-vec 块只词法命中。

import { randomUUID } from 'node:crypto'
import { getDb } from '../storage/db'
import { flatIndex } from './flat-index'
import { tokenizeForFts } from '../storage/memory/l3'

/** 实体类型（每实体一索引，§四:147） */
export type VectorEntity = 'kb_chunks'

export interface KbChunkRecord {
  /** 形如 kb_{uuid}；不传则自动生成 */
  id?: string
  kbId: string
  docId: string
  chunkIdx: number
  content: string
  /** 已归一化的向量（Float32Array）；null/undefined = 未向量化（离线兜底） */
  vec?: Float32Array | null
  /** JSON 字符串（来源路径/标题/页码/标签/conf） */
  meta?: string | null
}

export interface KbDocRecord {
  id: string
  title: string
  sourcePath?: string | null
  sourceKind?: string | null
  chunks?: number
  embeddingProvider?: string | null
  /** 原文存档（v11 列）：换分块策略/模型可重切不丢文档（kb_chunks.content 是片段拿不回原文） */
  content?: string | null
  createdAt?: number
  updatedAt?: number
}

export interface VectorSearchHit {
  id: string
  score: number
}

export interface VectorSearchOptions {
  /** 限定只在这些 doc_id 内扫（sharded 模式生效） */
  docIds?: string[]
  topK?: number
}

/**
 * Float32Array → BLOB（Buffer）。
 * 关键：用 Buffer.from(arrayBuffer) 时若源 Float32Array 是大 buffer 的视图（byteOffset≠0），
 * 必须传 offset/length 截取，否则会带出整段底层 buffer（§五测试覆盖 byteOffset）。
 */
export function vecToBlob(vec: Float32Array): Buffer {
  // slice 出独立的 ArrayBuffer（脱离视图的 byteOffset），再包 Buffer
  const ab = vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength)
  return Buffer.from(ab)
}

/** BLOB → Float32Array（维度由 vec_dim 决定，或按 byteLength/4 推断） */
export function blobToVec(blob: Uint8Array, dim?: number): Float32Array {
  const expected = dim ?? blob.byteLength / 4
  return new Float32Array(
    blob.buffer,
    blob.byteOffset,
    Math.min(expected, blob.byteLength / 4),
  )
}

/** kb_chunks 写入 + kb_chunks_fts 双写（不含 kb_docs——由调用方 upsertKbDoc 写元信息） */
export function insertKbChunks(records: KbChunkRecord[]): string[] {
  const db = getDb()
  const ids: string[] = []
  const insChunk = db.prepare(
    `INSERT INTO kb_chunks (id, kb_id, doc_id, chunk_idx, content, vec, vec_dim, meta, created_at)
     VALUES (@id, @kbId, @docId, @chunkIdx, @content, @vec, @vecDim, @meta, @createdAt)`,
  )
  const insFts = db.prepare(
    `INSERT INTO kb_chunks_fts (chunk_id, content_tokenized, content_raw, doc_id)
     VALUES (?, ?, ?, ?)`,
  )
  // 先删同 doc_id 旧块（幂等：同 doc_id 重摄取 → 先删旧块，§五:162）
  const delChunk = db.prepare('DELETE FROM kb_chunks WHERE doc_id = ?')
  const delFts = db.prepare(
    "DELETE FROM kb_chunks_fts WHERE doc_id = ?",
  )
  const now = Date.now()
  // 按 doc_id 分组以便删旧 + 计数
  const byDoc = new Map<string, KbChunkRecord[]>()
  for (const r of records) {
    const g = byDoc.get(r.docId) ?? []
    g.push(r)
    byDoc.set(r.docId, g)
  }
  db.transaction(() => {
    for (const [docId, items] of byDoc) {
      delChunk.run(docId)
      delFts.run(docId)
      // 排序 chunk_idx 保证有序
      items.sort((a, b) => a.chunkIdx - b.chunkIdx)
      for (const r of items) {
        const id = r.id ?? `kb_${randomUUID()}`
        ids.push(id)
        const dim = r.vec ? r.vec.length : null
        insChunk.run({
          id,
          kbId: r.kbId,
          docId: r.docId,
          chunkIdx: r.chunkIdx,
          content: r.content,
          vec: r.vec ? vecToBlob(r.vec) : null,
          vecDim: dim,
          meta: r.meta ?? null,
          createdAt: now,
        })
        insFts.run(id, tokenizeForFts(r.content), r.content, r.docId)
      }
    }
  })()
  // 写入后失效内存索引（P0 最简：下次 search 触发重载）
  flatIndex.invalidate()
  return ids
}

/** upsert 单个 kb_doc 元信息（含原文存档 content 列；chunks 计数由调用方算好传入） */
export function upsertKbDoc(doc: KbDocRecord): void {
  const db = getDb()
  const now = doc.createdAt ?? Date.now()
  db.prepare(
    `INSERT INTO kb_docs (id, title, source_path, source_kind, chunks, embedding_provider, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, source_path=excluded.source_path, source_kind=excluded.source_kind,
       chunks=excluded.chunks, embedding_provider=excluded.embedding_provider,
       content=excluded.content, updated_at=excluded.updated_at`,
  ).run(
    doc.id,
    doc.title,
    doc.sourcePath ?? null,
    doc.sourceKind ?? null,
    doc.chunks ?? 0,
    doc.embeddingProvider ?? null,
    doc.content ?? null,
    now,
    doc.updatedAt ?? now,
  )
}

/** 删除某文档所有块 + FTS */
export function deleteKbDoc(docId: string): void {
  const db = getDb()
  db.transaction(() => {
    db.prepare('DELETE FROM kb_chunks WHERE doc_id = ?').run(docId)
    db.prepare('DELETE FROM kb_chunks_fts WHERE doc_id = ?').run(docId)
    db.prepare('DELETE FROM kb_docs WHERE id = ?').run(docId)
  })()
  flatIndex.invalidate()
}

/** 读单个 chunk（含 vec → Float32Array） */
export function getKbChunk(
  id: string,
): (KbChunkRecord & {
  vec: Float32Array | null
  vecDim: number | null
  createdAt: number
}) | null {
  const db = getDb()
  const row = db
    .prepare(
      'SELECT id, kb_id as kbId, doc_id as docId, chunk_idx as chunkIdx, content, vec, vec_dim as vecDim, meta, created_at as createdAt FROM kb_chunks WHERE id = ?',
    )
    .get(id) as
    | {
        id: string
        kbId: string
        docId: string
        chunkIdx: number
        content: string
        vec: Uint8Array | null
        vecDim: number | null
        meta: string | null
        createdAt: number
      }
    | undefined
  if (!row) return null
  return {
    id: row.id,
    kbId: row.kbId,
    docId: row.docId,
    chunkIdx: row.chunkIdx,
    content: row.content,
    vec: row.vec && row.vecDim ? blobToVec(row.vec, row.vecDim) : null,
    vecDim: row.vecDim,
    meta: row.meta,
    createdAt: row.createdAt,
  }
}

/**
 * 向量检索（委托 flat-index.ts）。
 * 返回 Top-k {id, score}。embedding 不可用 / 维度漂移 / 分片降级 → 返回空 + degraded。
 * 调用方（P2 search.ts）据 degraded 走纯词法兜底。
 */
export function searchKbVectors(
  query: Float32Array,
  opts: VectorSearchOptions = {},
): { hits: VectorSearchHit[]; degraded: boolean } {
  const { results, degraded } = flatIndex.search(query, opts)
  return { hits: results, degraded }
}

/** 更新某 chunk 的向量（kb:reindex 补齐用，模型就绪后批量补 NULL-vec 块） */
export function updateKbChunkVec(id: string, vec: Float32Array): void {
  const db = getDb()
  db.prepare('UPDATE kb_chunks SET vec = ?, vec_dim = ? WHERE id = ?').run(
    vecToBlob(vec),
    vec.length,
    id,
  )
  flatIndex.invalidate()
}

/** 列出所有 vec IS NULL 的 chunk id（reindex 批量补向量用） */
export function listNullVecChunkIds(): { id: string; content: string }[] {
  return getDb()
    .prepare('SELECT id, content FROM kb_chunks WHERE vec IS NULL')
    .all() as { id: string; content: string }[]
}

/** 列出所有 kb_docs（含原文 content；用于 reindex 重切或导出） */
export function listKbDocs(): KbDocRecord[] {
  return getDb()
    .prepare(
      'SELECT id, title, source_path as sourcePath, source_kind as sourceKind, chunks, embedding_provider as embeddingProvider, content, created_at as createdAt, updated_at as updatedAt FROM kb_docs ORDER BY updated_at DESC',
    )
    .all() as KbDocRecord[]
}

/** 列出 kb_docs 元信息（不含 content 原文；避免大原文过 IPC 传给前端列表） */
export function listKbDocsLite(): KbDocRecord[] {
  return getDb()
    .prepare(
      'SELECT id, title, source_path as sourcePath, source_kind as sourceKind, chunks, embedding_provider as embeddingProvider, created_at as createdAt, updated_at as updatedAt FROM kb_docs ORDER BY updated_at DESC',
    )
    .all() as KbDocRecord[]
}
