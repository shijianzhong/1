// —— KB hybrid 检索（docs/VECTOR_KB_PLAN.md §六:175-179）——
//
// 向量（FlatIndex cosine）+ 词法（FTS5 BM25 + LIKE 兜底）双路召回，
// RRF 倒数排名融合（与分值尺度无关 → cosine 0~1 与 BM25 公平并列），
// 回表取 content + 文档标题，返回 {hits, degraded}。
//
// spike 实测纯向量在关键词密集短文本不如 FTS（SKILL_RAG_EVAL.md），
// 故 P2 必须 hybrid 融合，非向量替代词法。
//
// 降级链（绝不抛，§六:179）：
//   - provider 未就绪 / embed 失败 → vec=null（worker-client 已 catch 成 null）→ 跳向量路，纯词法
//   - FTS5 极端字符炸语法 → searchKbFts 内 try/catch 退 LIKE；LIKE 也空 → 只向量
//   - 两路都空 → hits:[]
// degraded=true 表示向量路未参与（前端显示「纯词法」badge）。

import { getLocalProvider } from './embed'
import { searchKbVectors, fetchKbChunksWithDoc, type KbChunkWithDoc } from './store'
import { searchKbFts } from './kb-fts'
import { rrfFuseTopN, rankedChannel } from './rrf'
import { logger } from '../logger'
import type { KbSearchHit } from '@shared/types'

export interface KbSearchOptions {
  /** 返回上限（默认 5） */
  k?: number
  /** 限定在这些 doc_id 内检索（sharded 模式；向量路与词法路同口径过滤） */
  docIds?: string[]
}

export interface KbSearchResult {
  hits: KbSearchHit[]
  /** 向量路未参与（provider 未就绪 / 维度漂移 / 索引降级）→ 纯词法命中 */
  degraded: boolean
}

/** 解析 chunk meta JSON 取 sectionTitle + source（容错：非法 JSON → null） */
function parseChunkMeta(meta: string | null): { sectionTitle?: string | null; source?: string | null } {
  if (!meta) return {}
  try {
    const m = JSON.parse(meta) as { sectionTitle?: string | null; source?: string | null }
    return { sectionTitle: m.sectionTitle ?? null, source: m.source ?? null }
  } catch {
    return {}
  }
}

/**
 * KB hybrid 检索。同步返回（embed 是异步，但调用方 await 整体 Promise）。
 * 绝不抛：任何子路异常都降级，最终返回 {hits:[], degraded}。
 */
export async function searchKbHybrid(query: string, opts: KbSearchOptions = {}): Promise<KbSearchResult> {
  const topK = Math.max(1, opts.k ?? 5)
  const docIds = opts.docIds
  const trimmed = query?.trim() ?? ''

  if (!trimmed) return { hits: [], degraded: false }

  const channels = []
  let degraded = false

  // —— 向量路：embed query（e5 非对称 search 传 'query'，与 ingestion 'passage' 对称）——
  const provider = getLocalProvider()
  let vecChannel = null
  const ready = await provider.ready().catch(() => false)
  if (ready) {
    const vecs = await provider.embed([trimmed], undefined, 'query').catch((e) => {
      logger.warn('[kb-search] embed query 失败，跳向量路走纯词法', e)
      return null
    })
    const qVec = vecs?.[0] ?? null
    if (qVec) {
      const { hits, degraded: vecDegraded } = searchKbVectors(qVec, { docIds, topK })
      if (!vecDegraded && hits.length > 0) {
        // flat-index 非分片路径不过滤 docIds（searchFlat 全扫），
        // 在此按 doc_id 后置过滤，保证 docIds 限定在向量路也生效。
        // 命中 id → 需查 doc_id 判定；为避免逐条查库，依赖后续 fetchKbChunksWithDoc
        // 取回 docId 后再过滤（见下方 fused → hits 组装处）。此处先不过滤 vec 候选，
        // 让 RRF 融合后统一在 fetch 阶段按 docIds 裁剪。
        vecChannel = rankedChannel(hits.map((h) => h.id))
      }
      if (vecDegraded) degraded = true
    } else {
      // embed 返回 null（worker catch）→ 向量路缺失
      degraded = true
    }
    if (vecChannel) channels.push(vecChannel)
  } else {
    // provider 未就绪 → 纯词法
    degraded = true
  }

  // —— 词法路：FTS5 BM25 + LIKE 兜底 ——
  const ftsIds = searchKbFts(trimmed, topK, docIds)
  if (ftsIds.length > 0) {
    channels.push(rankedChannel(ftsIds))
  }

  // —— RRF 融合 + 回表 ——
  if (channels.length === 0) {
    return { hits: [], degraded }
  }
  const fused = rrfFuseTopN(channels, topK)
  if (fused.length === 0) return { hits: [], degraded }

  const chunkMap = new Map<string, KbChunkWithDoc>()
  for (const c of fetchKbChunksWithDoc(fused.map((f) => f.id))) {
    chunkMap.set(c.id, c)
  }

  const hits: KbSearchHit[] = []
  const docIdSet = docIds && docIds.length > 0 ? new Set(docIds) : null
  for (const f of fused) {
    const c = chunkMap.get(f.id)
    if (!c) continue // chunk 已删（融合与回表之间窗口期）→ 跳过
    // flat-index 非分片路径不过滤 docIds，在此统一裁剪（向量路召回的跨文档候选）
    if (docIdSet && !docIdSet.has(c.docId)) continue
    const meta = parseChunkMeta(c.meta)
    hits.push({
      docId: c.docId,
      title: c.title,
      chunkId: c.id,
      content: c.content,
      score: f.score,
      source: meta.source ?? c.sourcePath ?? null,
      sectionTitle: meta.sectionTitle ?? null,
    })
  }

  return { hits, degraded }
}
