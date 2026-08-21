// —— KB reindex 执行（docs/VECTOR_KB_PLAN.md §四:144 + §八 P4 + §九 风险3）——
//
// 闭合 P1 留下的「vec=NULL 待补」缺口 + provider/维度切换时的全量重嵌。
// 两种情形统一走 listNullVecChunkIds：
//   (a) 增量补齐（模型刚下好）：只 backfill NULL-vec 块，不动已有向量
//   (b) 全量重嵌（provider/dim 切换）：先 clearAllKbVecs 把旧维度向量全置 NULL，
//       之后 listNullVecChunkIds 覆盖全部 chunk → 同一 backfill 路径
//
// kb_reindex_required app_meta key 触发 (b)：由 checkVecDimDrift（dim 漂移）
// 或 setActiveProvider（provider 切换）写入，本模块读完即清。
//
// 进度流镜像 orchestrate.ts:56-63（getMainWindow + emitProgress 闭包，
// webContents.send 单向推，与 withHandler 返回值解耦）。
// §九 风险3：10k 块本地 WASM 重嵌分钟级，严禁同步阻塞——本循环 await 逐批，
// 主进程事件循环不被 WASM 阻塞（推理在 worker 子进程 / 远程在 network I/O）。

import { BrowserWindow } from 'electron'
import { getActiveProvider, providerTagFor } from './embed'
import {
  listNullVecChunkIds,
  updateKbChunkVecBatch,
  clearAllKbVecs,
  updateKbDocsEmbeddingProvider,
} from './store'
import { initFlatIndex, flatIndex } from './flat-index'
import { getAppMeta, setAppMeta } from '../storage/db'
import { IpcErrorThrow } from '@shared/types'
import { logger } from '../logger'
import type { KbReindexProgressEvent, KbReindexResult } from '@shared/types'

const PROGRESS_CHANNEL = 'kb:reindex:progress'
const BATCH_SIZE = 32

let reindexController: AbortController | null = null

function getMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

function emitProgress(ev: KbReindexProgressEvent): void {
  getMainWindow()?.webContents.send(PROGRESS_CHANNEL, ev)
}

/**
 * 执行 reindex。返回 {total, embedded, failed}。
 * 进度经 kb:reindex:progress channel 推送（progress/done/error）。
 * provider 未就绪 → throw IpcErrorThrow（被 withHandler 包成 IpcFailure）。
 */
export async function runReindex(): Promise<KbReindexResult> {
  reindexController = new AbortController()
  const signal = reindexController.signal

  const provider = getActiveProvider()
  const ready = await provider.ready().catch(() => false)
  if (!ready) {
    reindexController = null
    throw new IpcErrorThrow('errors:kb.provider_not_ready')
  }

  try {
    // 1. 全量重嵌判定：kb_reindex_required='1' → 先清空所有旧维度向量
    //    clearAllKbVecs 后 listNullVecChunkIds 覆盖全部 chunk
    //    无 reindexRequired（模型刚下好）→ 只 backfill NULL（增量）
    const reindexRequired = getAppMeta('kb_reindex_required') === '1'
    let clearedAll = false
    if (reindexRequired) {
      clearAllKbVecs()
      clearedAll = true
      logger.info('[kb-reindex] 维度/provider 漂移 → 全量重嵌（已清空旧向量）')
    }

    // 2. 批量 backfill NULL-vec chunks
    const nullChunks = listNullVecChunkIds()
    const total = nullChunks.length
    let embedded = 0
    let failed = 0

    if (total === 0) {
      // 无 NULL 块也无需重嵌 → 清标志 + 返回
      setAppMeta('kb_reindex_required', '')
      emitProgress({ type: 'done', done: 0, total: 0 })
      return { total: 0, embedded: 0, failed: 0 }
    }

    let cancelled = false
    for (let i = 0; i < total; i += BATCH_SIZE) {
      if (signal.aborted) {
        cancelled = true
        break
      }
      const batch = nullChunks.slice(i, i + BATCH_SIZE)
      const texts = batch.map((c) => c.content)
      const vecs = await provider.embed(texts, signal, 'passage')
      const updates: { id: string; vec: Float32Array }[] = []
      for (let j = 0; j < batch.length; j++) {
        if (vecs[j]) {
          updates.push({ id: batch[j].id, vec: vecs[j]! })
          embedded++
        } else {
          failed++
        }
      }
      if (updates.length > 0) updateKbChunkVecBatch(updates)
      emitProgress({
        type: 'progress',
        done: Math.min(i + BATCH_SIZE, total),
        total,
      })
    }

    // 取消收尾：已 clearAll 的全量重嵌被取消时，旧向量已清、新向量未补完——
    // 必须保留 reindex 标志，否则 UI 不再提示而全库 vec=NULL 长期裸奔
    // （真实问题不是「取消后标志不清」，而是「取消后标志被清、进度当 done」）。
    if (cancelled) {
      if (clearedAll) setAppMeta('kb_reindex_required', '1')
      flatIndex.invalidate() // 部分批次已写入，下次 search 惰性重载
      emitProgress({ type: 'cancelled', done: embedded, total })
      logger.info(`[kb-reindex] 已取消：embedded=${embedded} failed=${failed} total=${total}`)
      return { total, embedded, failed }
    }

    // 3. 清 reindex 标志 + 回标 doc provider + warm index
    setAppMeta('kb_reindex_required', '')
    updateKbDocsEmbeddingProvider(providerTagFor(provider))
    // 统一一次 invalidate + warm（updateKbChunkVecBatch 不逐条 invalidate；
    // 显式 warm 省掉首次搜索的全量重载延迟——search 本身也会惰性重载，review #1）
    flatIndex.invalidate()
    initFlatIndex()

    emitProgress({ type: 'done', done: embedded, total })
    logger.info(
      `[kb-reindex] 完成：embedded=${embedded} failed=${failed} total=${total}`,
    )
    return { total, embedded, failed }
  } catch (e) {
    emitProgress({
      type: 'error',
      done: 0,
      total: 0,
      message: e instanceof Error ? e.message : String(e),
    })
    throw e
  } finally {
    reindexController = null
  }
}

/** 取消正在进行的 reindex（镜像 orchestrate:cancel 的 AbortController 翻转） */
export function cancelReindex(): void {
  reindexController?.abort()
  reindexController = null
}
