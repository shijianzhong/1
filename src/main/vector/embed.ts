// —— EmbeddingProvider 抽象 + 本地 provider facade（docs/VECTOR_KB_PLAN.md §二）——
//
// 接口形态见文档 §二:48-57。两条实现挂同一接口：本地（transformers.js WASM worker）
// 与远程（P4 OpenAI /embeddings，P0 仅占位）。默认本地。
//
// 主进程绝不 import transformers（worker-embed.cjs 在子进程里 import）。
// LocalProvider 的 ready() 只做文件系统检查（模型在否），不 spawn；embed() 才委托
// worker-client spawn 拉起子进程。这样 kb:status 探测不启动 worker，首调 embed 才起。

import { existsSync, readdirSync } from 'node:fs'
import { getKbModelDir } from '../storage/paths'
import { getDb } from '../storage/db'
import { countKbChunks } from './kb-fts'
import { initFlatIndex } from './flat-index'
import {
  DEFAULT_MODEL_DIM,
  DEFAULT_MODEL_ID,
  embedBatchViaWorker,
  type EmbedKind,
} from './worker-client'
import { logger } from '../logger'
import type { KbStatus } from '@shared/types'

/** 默认模型是否 e5 系（非对称，需 query:/passage: 前缀）。与 worker-embed.cjs IS_E5 同口径。 */
const IS_E5_MODEL = /e5/i.test(DEFAULT_MODEL_ID)

export interface EmbeddingProvider {
  readonly kind: 'local' | 'remote'
  /** 预检：本地模型已加载 / 远程已配 key+model。不 spawn，仅探测 */
  ready(): Promise<boolean>
  /** 维度（模型就绪前用 DEFAULT_MODEL_DIM 预期值） */
  dimension(): number
  /** 批量 embed；失败条目返回 null（降级，不抛）。
   *  @param kind e5 非对称角色：ingestion 传 'passage'，search query 传 'query'。 */
  embed(texts: string[], signal?: AbortSignal, kind?: EmbedKind): Promise<(Float32Array | null)[]>
}

/**
 * 本地 transformers.js（WASM worker）provider。
 * ready() 查 userData/kb-models 下是否有模型文件（full 包首启复制到此 / slim 运行时下载到此）。
 */
class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'local' as const

  async ready(): Promise<boolean> {
    // 模型目录有 onnx 权重即视为就绪（worker 首调会加载进内存）
    return hasLocalModel()
  }

  dimension(): number {
    return DEFAULT_MODEL_DIM
  }

  embed(texts: string[], signal?: AbortSignal, kind?: EmbedKind): Promise<(Float32Array | null)[]> {
    // e5 非对称模型缺 kind → 静默掉前缀（query/passage 不加），召回会静默变差。
    // 此处显式 warn（不抛：降级链要求永不抛；静默无前缀向量仍可用作 RRF 补强，
    // 但须让调用方在日志看见）。非 e5 模型（bge 等）无前缀约定，kind 缺失正常。
    if (IS_E5_MODEL && !kind) {
      logger.warn(
        `[embed] e5 模型 (${DEFAULT_MODEL_ID}) 缺 kind 参数：ingestion 应传 'passage'、search query 应传 'query'，未传将不加前缀（召回质量静默下降）`,
      )
    }
    return embedBatchViaWorker(texts, signal, kind)
  }
}

/** 进程内懒单例 */
let localProvider: LocalEmbeddingProvider | null = null
export function getLocalProvider(): LocalEmbeddingProvider {
  if (!localProvider) localProvider = new LocalEmbeddingProvider()
  return localProvider
}

/** 模型目录是否有可用模型文件（onnx 权重 + tokenizer） */
function hasLocalModel(): boolean {
  const dir = getKbModelDir()
  if (!existsSync(dir)) return false
  // 量化模型 onnx 可能叫 model.onnx / model_quantized.onnx / 在 onnx/ 子目录
  // 宽松判断：目录非空且有 .onnx 文件
  try {
    const entries = readdirSync(dir, { recursive: true })
    return entries.some((e) => String(e).endsWith('.onnx'))
  } catch {
    return false
  }
}

/**
 * kb:status 整体就绪态（文档 §二:87 降级链）。
 * P0：本地 provider 探测（不 spawn）。远程 provider P4 接入后在此分支。
 */
export async function getKbStatus(): Promise<KbStatus> {
  const modelDir = getKbModelDir()
  const hasModel = hasLocalModel()
  let chunkCount = 0
  try {
    chunkCount = countKbChunks()
  } catch {
    // db 未就绪（极早期调用）→ 0
  }

  let embedding: KbStatus['embedding']
  if (hasModel) {
    embedding = 'ready'
  } else {
    embedding = 'missing' // slim 包未下载 / full 包未首启复制
  }

  return {
    embedding,
    dimension: hasModel ? DEFAULT_MODEL_DIM : null,
    provider: hasModel ? 'local' : 'none',
    chunkCount,
    modelDir,
  }
}

/**
 * 启动自检：库内存量向量维度 ≠ 当前 provider 维度 → 标记需重嵌。
 * 由 index.ts app.ready 后 void initKbStatus() 调（非阻塞）。
 * db.ts 启动已做 vec_dim 多值检测（写 kb_reindex_required）；此处做单值漂移检测
 * （库内全是旧维度 384，但换到 bge-m3 1024 → 旧向量全废，需重嵌）。
 */
export function checkVecDimDrift(): void {
  try {
    const db = getDb()
    const row = db
      .prepare(
        'SELECT DISTINCT vec_dim FROM kb_chunks WHERE vec IS NOT NULL AND vec_dim IS NOT NULL LIMIT 1',
      )
      .get() as { vec_dim: number } | undefined
    if (row && row.vec_dim !== DEFAULT_MODEL_DIM) {
      db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(
        'kb_reindex_required',
        '1',
      )
      logger.warn(
        `[embed] 检测到向量维度漂移：库存 ${row.vec_dim} ≠ 当前 ${DEFAULT_MODEL_DIM}，已标记 kb:reindex`,
      )
    }
  } catch (e) {
    // 非致命
  }
}

/**
 * 启动自检入口（index.ts app.ready 后 void 调，非阻塞）：
 * 1. flatIndex 懒加载已有向量到内存（失败走纯词法兜底，不崩）
 * 2. vec_dim 漂移检测（库内单值 ≠ 当前 provider 维度 → 标 kb_reindex_required）
 * 顺序：先加载索引（即便维度漂移也能加载供 FTS 配合），再检测漂移。
 */
export function initKbStatus(): void {
  try {
    initFlatIndex()
  } catch (e) {
    logger.warn('[embed] initKbStatus: flatIndex 加载失败，降级纯词法', e)
  }
  try {
    checkVecDimDrift()
  } catch (e) {
    // 非致命
  }
}

// 模型 id 单点（worker-client 默认 + spike + 重嵌共用；换模型改这一处）
export const KB_MODEL_ID = DEFAULT_MODEL_ID
export const KB_MODEL_DIM = DEFAULT_MODEL_DIM
