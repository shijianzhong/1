// —— EmbeddingProvider 抽象 + 本地/远程 provider facade（docs/VECTOR_KB_PLAN.md §二）——
//
// 接口形态见文档 §二:48-57。两条实现挂同一接口：本地（transformers.js WASM worker）
// 与远程（P4 OpenAI /embeddings，bare fetch，网络 I/O 非阻塞故不经 worker）。
//
// 主进程绝不 import transformers（worker-embed.cjs 在子进程里 import）。
// LocalProvider 的 ready() 只做文件系统检查（模型在否），不 spawn；embed() 才委托
// worker-client spawn 拉起子进程。这样 kb:status 探测不启动 worker，首调 embed 才起。
// RemoteProvider 的 ready() 只做配置检查（key+baseUrl+model 在否），不网络探测；embed() 才 fetch。

import { existsSync, readdirSync } from 'node:fs'
import { getKbModelDir } from '../storage/paths'
import { getDb, getAppMeta, setAppMeta } from '../storage/db'
import { countKbChunks } from './kb-fts'
import { initFlatIndex } from './flat-index'
import { getProvider } from '../storage/models'
import { getKey } from '../secrets/vault'
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
  /** P4: 模型 id（remote 为远程 embedding model，local 为 null） */
  readonly modelId: string | null
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
  readonly modelId = null

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

// —— P4: 远程 OpenAI provider（/embeddings，bare fetch）——
// 与 local 不同：网络 I/O 非阻塞，不走 worker（worker 是为 CPU-bound WASM 推理隔离主线程）。
// OpenAI text-embedding-3-* 返回已 L2 归一化向量，客户端不再归一化（与 local e5 worker 不同）。

/** 已知远程 embedding 模型维度（免网络探测；未知模型首 embed 后回填 app_meta） */
const KNOWN_REMOTE_DIMS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
}

/**
 * 远程 embedding provider（OpenAI /embeddings 兼容）。
 * ready() 只做配置检查（镜像 local no-spawn 哲学，不网络探测）。
 * dimension() 静态查表 → app_meta 缓存 → 未知返回 0（checkVecDimDrift 跳过）。
 * embed() POST /embeddings，HTTP 错/异常 → 全 null（降级，不抛），首成功 embed 回填维度。
 */
class RemoteEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'remote' as const
  private cachedDim: number | null = null

  /** provider id（来自 Provider.id，用于回标 kb_docs.embedding_provider） */
  readonly providerId: string
  /** 远程 embedding 模型 id（getKbStatus 读此字段回传前端） */
  readonly modelId: string
  private readonly apiKey: string
  private baseURL: string
  private readonly authHeader: string

  constructor(
    providerId: string,
    modelId: string,
    apiKey: string,
    baseURL: string,
    authHeader: string,
  ) {
    this.providerId = providerId
    this.modelId = modelId
    this.apiKey = apiKey
    this.baseURL = baseURL.replace(/\/$/, '')
    this.authHeader = authHeader
  }

  async ready(): Promise<boolean> {
    return !!this.apiKey && !!this.baseURL && !!this.modelId
  }

  dimension(): number {
    if (this.cachedDim != null) return this.cachedDim
    // 1. 静态查表（已知模型）
    const known = KNOWN_REMOTE_DIMS[this.modelId]
    if (known) {
      this.cachedDim = known
      return known
    }
    // 2. app_meta 缓存（首 embed 后写入）
    const cached = getAppMeta(`kb_remote_dim:${this.modelId}`)
    if (cached) {
      const n = parseInt(cached, 10)
      if (Number.isFinite(n) && n > 0) {
        this.cachedDim = n
        return n
      }
    }
    // 3. 未知 → 返回 0（checkVecDimDrift 跳过；首 embed 后回填）
    return 0
  }

  async embed(
    texts: string[],
    signal?: AbortSignal,
    _kind?: EmbedKind,
  ): Promise<(Float32Array | null)[]> {
    if (texts.length === 0) return []
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      // auth header 逻辑镜像 openai-client.ts:82-86
      if (this.authHeader === 'x-api-key') {
        headers['x-api-key'] = this.apiKey
      } else {
        headers['Authorization'] = `Bearer ${this.apiKey}`
      }
      const url = `${this.baseURL}/embeddings`
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: this.modelId, input: texts }),
        signal,
      })
      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        logger.warn(
          `[embed:remote] /embeddings HTTP ${res.status}: ${errText.slice(0, 200)}`,
        )
        return texts.map(() => null)
      }
      const json = (await res.json()) as { data: Array<{ embedding: number[] }> }
      const out: (Float32Array | null)[] = json.data.map((d) =>
        d.embedding && d.embedding.length > 0 ? Float32Array.from(d.embedding) : null,
      )
      // 首成功 embed 回填维度缓存（后续启动 / drift 检测可用）
      if (this.cachedDim == null && out[0]) {
        this.cachedDim = out[0].length
        setAppMeta(`kb_remote_dim:${this.modelId}`, String(this.cachedDim))
      }
      return out
    } catch (e) {
      logger.warn('[embed:remote] embed 失败，降级 null', e)
      return texts.map(() => null)
    }
  }
}

/**
 * 当前活跃 embedding provider（app_meta kb_embedding_provider_id 决定）。
 * 不缓存 RemoteEmbeddingProvider——用户在 Settings 改 key 后缓存实例持旧 apiKey。
 * 每次重新构造（开销小：读 app_meta + vault key）；local 走懒单例。
 */
export function getActiveProvider(): EmbeddingProvider {
  const prefId = getAppMeta('kb_embedding_provider_id')
  if (prefId) {
    const provider = getProvider(prefId)
    // 先判 embedding 槽存在（resolveModelIdByUsage 未配会回退 default/primary 聊天模型，错）
    if (provider?.models.embedding && provider.keyId) {
      const apiKey = getKey(provider.keyId)
      if (apiKey) {
        const baseURL = provider.baseUrl || 'https://api.openai.com/v1'
        const authHeader = provider.authHeader || 'authorization'
        return new RemoteEmbeddingProvider(
          provider.id,
          provider.models.embedding,
          apiKey,
          baseURL,
          authHeader,
        )
      }
    }
    // 配了 pref 但 provider/key/embedding 缺 → 降级 local（config-error 在 getKbStatus 体现）
  }
  return getLocalProvider()
}

/**
 * 设置活跃 embedding provider（写 app_meta + 标记重嵌）。
 * @param providerId null=用本地；否则=用该 provider.id 走远程
 */
export function setActiveProvider(providerId: string | null): void {
  setAppMeta('kb_embedding_provider_id', providerId ?? '')
  // provider 切换 → 向量空间可能变（384↔1536）→ 标重嵌
  setAppMeta('kb_reindex_required', '1')
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
 * P4: 分支 active provider——remote+ready → ready/remote；remote+未配 → config-error；
 * local+ready → ready/local；local+missing → missing/none。
 */
export async function getKbStatus(): Promise<KbStatus> {
  const modelDir = getKbModelDir()
  let chunkCount = 0
  try {
    chunkCount = countKbChunks()
  } catch {
    // db 未就绪（极早期调用）→ 0
  }

  const provider = getActiveProvider()
  const ready = await provider.ready().catch(() => false)
  const reindexRequired = getAppMeta('kb_reindex_required') === '1'
  const prefId = getAppMeta('kb_embedding_provider_id')

  let embedding: KbStatus['embedding']
  let dimension: number | null
  let providerKind: KbStatus['provider']

  if (provider.kind === 'remote') {
    if (ready) {
      embedding = 'ready'
      dimension = provider.dimension()
      providerKind = 'remote'
    } else {
      // 配了 remote 但 key/model/baseUrl 缺 → 配置不完整
      embedding = 'config-error'
      dimension = null
      providerKind = 'none'
    }
  } else {
    // local
    if (ready) {
      embedding = 'ready'
      dimension = provider.dimension()
      providerKind = 'local'
    } else {
      embedding = 'missing' // slim 包未下载 / full 包未首启复制
      dimension = null
      providerKind = 'none'
    }
  }

  return {
    embedding,
    dimension,
    provider: providerKind,
    chunkCount,
    modelDir,
    reindexRequired,
    activeProviderId: prefId || null,
    embeddingModel: provider.kind === 'remote' ? provider.modelId : null,
  }
}

/**
 * 启动自检：库内存量向量维度 ≠ 当前 provider 维度 → 标记需重嵌。
 * 由 index.ts app.ready 后 void initKbStatus() 调（非阻塞）。
 * db.ts 启动已做 vec_dim 多值检测（写 kb_reindex_required）；此处做单值漂移检测
 * （库内全是旧维度 384，但换到 remote 1536 → 旧向量全废，需重嵌）。
 * P4: 比较对象从 DEFAULT_MODEL_DIM 改为 getActiveProvider().dimension()，
 *     dim===0（未知远程模型，首 embed 前无维度）时跳过——首 embed 后才知维度，
 *     后续启动检测漂移。
 */
export function checkVecDimDrift(): void {
  try {
    const currentDim = getActiveProvider().dimension()
    if (currentDim === 0) return // 未知远程模型维度 → 跳过（首 embed 后回填，下次启动检测）
    const db = getDb()
    const row = db
      .prepare(
        'SELECT DISTINCT vec_dim FROM kb_chunks WHERE vec IS NOT NULL AND vec_dim IS NOT NULL LIMIT 1',
      )
      .get() as { vec_dim: number } | undefined
    if (row && row.vec_dim !== currentDim) {
      setAppMeta('kb_reindex_required', '1')
      logger.warn(
        `[embed] 检测到向量维度漂移：库存 ${row.vec_dim} ≠ 当前 ${currentDim}，已标记 kb:reindex`,
      )
    }
  } catch {
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
