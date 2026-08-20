// —— 内存 Flat 暴力向量索引（docs/VECTOR_KB_PLAN.md §三:101-107）——
//
// 单用户桌面，知识库分块量级千到几万条。Flat 暴力 top-k 在几万条 × 1024 维时
// 毫秒级，不引入 HNSW/native 的构建复杂度。向量以 BLOB 存 SQLite 主表（store.ts），
// 内存建 Float32Array 拼接索引加速 cosine 点积（避免逐行反序列化）。
//
// 硬上限 + 分片/降级（§四:148）：全内存索引 4KB/条，30 万条 ≈ 1.2GB RAM。
// 设 HARD_CAP=20000 全内存；超出按 doc_id 分片，查询时只扫命中文档分片；
// 分片也超限则该次检索 degraded（调用方 P2 退化纯 FTS5，配合降级链不崩）。
//
// 向量已归一化（worker 内 L2 normalize 过）→ cosine = 点积，无需再除模。

import { getDb } from '../storage/db'

/** 全内存索引硬上限（§四:148） */
export const HARD_CAP = 20000

interface SearchResult {
  id: string
  score: number
}

interface SearchOptions {
  /** 限定只在这些 doc_id 的分片里扫（sharded 模式下生效） */
  docIds?: string[]
  /** 返回前 N 条 */
  topK?: number
}

interface ShardedState {
  /** doc_id → 该文档所有向量的 Float32Array（dim*N 拼接） */
  byDoc: Map<string, Float32Array>
  /** doc_id → 该文档的 chunk id 有序列表（与向量数组顺序对齐） */
  idsByDoc: Map<string, string[]>
}

class FlatIndexImpl {
  private dim = 0
  private loaded = false
  private sharded = false

  // 非分片：全部向量拼接 + id 列表
  private vectors: Float32Array = new Float32Array(0)
  private ids: string[] = []

  // 分片
  private shardedState: ShardedState | null = null

  /** 维度（首个有向量的 chunk 决定；空库为 0） */
  get dimension(): number {
    return this.dim
  }

  /** 是否已加载 */
  get isLoaded(): boolean {
    return this.loaded
  }

  /** 是否分片态（超 HARD_CAP） */
  get isSharded(): boolean {
    return this.sharded
  }

  /** 已索引的向量数 */
  get count(): number {
    return this.sharded
      ? [...(this.shardedState?.idsByDoc.values() ?? [])].reduce((a, b) => a + b.length, 0)
      : this.ids.length
  }

  /**
   * 懒加载（app ready 后非阻塞调用）：读所有 vec IS NOT NULL。
   * count > HARD_CAP → sharded，按 doc_id 分片。
   */
  load(): void {
    if (this.loaded) return
    const db = getDb()
    const rows = db
      .prepare('SELECT id, doc_id, vec, vec_dim FROM kb_chunks WHERE vec IS NOT NULL')
      .all() as { id: string; doc_id: string; vec: Uint8Array; vec_dim: number }[]

    if (rows.length === 0) {
      this.loaded = true
      return
    }
    // 取维度（首个）；所有向量维度应一致（漂移由 db.ts 启动自检拦）
    this.dim = rows[0].vec_dim || rows[0].vec.byteLength / 4

    if (rows.length > HARD_CAP) {
      this.loadSharded(rows)
    } else {
      this.loadFlat(rows)
    }
    this.loaded = true
  }

  private loadFlat(
    rows: { id: string; doc_id: string; vec: Uint8Array; vec_dim: number }[],
  ): void {
    const n = rows.length
    const buf = new Float32Array(n * this.dim)
    const ids: string[] = new Array(n)
    for (let i = 0; i < n; i++) {
      // vec 是 BLOB，little-endian Float32；Float32Array view 直接读
      const view = new Float32Array(
        rows[i].vec.buffer,
        rows[i].vec.byteOffset,
        rows[i].vec.byteLength / 4,
      )
      buf.set(view, i * this.dim)
      ids[i] = rows[i].id
    }
    this.vectors = buf
    this.ids = ids
    this.sharded = false
  }

  private loadSharded(
    rows: { id: string; doc_id: string; vec: Uint8Array; vec_dim: number }[],
  ): void {
    // 先按 doc_id 分组
    const groups = new Map<string, { id: string; vec: Uint8Array }[]>()
    for (const r of rows) {
      const g = groups.get(r.doc_id) ?? []
      g.push({ id: r.id, vec: r.vec })
      groups.set(r.doc_id, g)
    }
    const byDoc = new Map<string, Float32Array>()
    const idsByDoc = new Map<string, string[]>()
    for (const [docId, items] of groups) {
      const buf = new Float32Array(items.length * this.dim)
      const ids: string[] = new Array(items.length)
      for (let i = 0; i < items.length; i++) {
        const view = new Float32Array(
          items[i].vec.buffer,
          items[i].vec.byteOffset,
          items[i].vec.byteLength / 4,
        )
        buf.set(view, i * this.dim)
        ids[i] = items[i].id
      }
      byDoc.set(docId, buf)
      idsByDoc.set(docId, ids)
    }
    this.shardedState = { byDoc, idsByDoc }
    this.sharded = true
  }

  /**
   * 检索：query 向量点积（已归一化 → cosine），返回 Top-k。
   *
   * @param query 已归一化的查询向量（Float32Array，维度须 == this.dim）
   * @returns {results, degraded}：sharded 无 docIds 过滤时 degraded=true（调用方走纯 FTS）
   */
  search(query: Float32Array, opts: SearchOptions = {}): {
    results: SearchResult[]
    degraded: boolean
  } {
    if (!this.loaded || this.dim === 0) return { results: [], degraded: false }
    if (query.length !== this.dim) {
      // 维度不匹配（漂移场景）——降级
      return { results: [], degraded: true }
    }
    const topK = opts.topK ?? 10

    if (this.sharded) {
      return this.searchSharded(query, opts, topK)
    }
    return { results: this.searchFlat(query, topK), degraded: false }
  }

  /** 非分片：全扫点积 + Top-k 堆 */
  private searchFlat(query: Float32Array, topK: number): SearchResult[] {
    const n = this.ids.length
    const step = this.dim
    const v = this.vectors
    // 用小顶堆维护 Top-k（避免全排序 n*log(n)）
    const heap: { id: string; score: number }[] = []
    for (let i = 0; i < n; i++) {
      let dot = 0
      const base = i * step
      for (let d = 0; d < step; d++) dot += v[base + d] * query[d]
      this.pushTopK(heap, this.ids[i], dot, topK)
    }
    // 堆是小顶（最小在顶），输出前反转成降序
    heap.sort((a, b) => b.score - a.score)
    return heap
  }

  private searchSharded(
    query: Float32Array,
    opts: SearchOptions,
    topK: number,
  ): { results: SearchResult[]; degraded: boolean } {
    const state = this.shardedState
    if (!state) return { results: [], degraded: true }
    // sharded 无 docIds → 扫全部分片 = 全量，等价于非分片但内存超限 → 降级
    if (!opts.docIds || opts.docIds.length === 0) {
      return { results: [], degraded: true }
    }
    const heap: { id: string; score: number }[] = []
    const seenDocs = new Set<string>()
    for (const docId of opts.docIds) {
      const buf = state.byDoc.get(docId)
      const ids = state.idsByDoc.get(docId)
      if (!buf || !ids) continue
      seenDocs.add(docId)
      const m = ids.length
      const step = this.dim
      for (let i = 0; i < m; i++) {
        let dot = 0
        const base = i * step
        for (let d = 0; d < step; d++) dot += buf[base + d] * query[d]
        this.pushTopK(heap, ids[i], dot, topK)
      }
    }
    // 候选文档全不命中 = 该次检索无向量候选 → 降级（调用方走纯 FTS）
    if (seenDocs.size === 0) return { results: [], degraded: true }
    heap.sort((a, b) => b.score - a.score)
    return { results: heap, degraded: false }
  }

  /** 维护 Top-k 小顶堆：新元素与堆顶（当前最小）比较，大于则替换后下沉 */
  private pushTopK(
    heap: { id: string; score: number }[],
    id: string,
    score: number,
    topK: number,
  ): void {
    if (heap.length < topK) {
      heap.push({ id, score })
      // 上浮到正确位置（小顶）
      let i = heap.length - 1
      while (i > 0) {
        const parent = (i - 1) >> 1
        if (heap[parent].score <= heap[i].score) break
        ;[heap[parent], heap[i]] = [heap[i], heap[parent]]
        i = parent
      }
    } else if (score > heap[0].score) {
      heap[0] = { id, score }
      // 下沉
      let i = 0
      const n = heap.length
      while (true) {
        let smallest = i
        const l = 2 * i + 1
        const r = 2 * i + 2
        if (l < n && heap[l].score < heap[smallest].score) smallest = l
        if (r < n && heap[r].score < heap[smallest].score) smallest = r
        if (smallest === i) break
        ;[heap[smallest], heap[i]] = [heap[i], heap[smallest]]
        i = smallest
      }
    }
  }

  /**
   * 增删后失效标记：P0 最简正确——add/remove 后置 loaded=false，
   * 下次 search/load 触发全量重载。P1 优化为增量更新。
   */
  invalidate(): void {
    this.loaded = false
    this.vectors = new Float32Array(0)
    this.ids = []
    this.shardedState = null
    this.sharded = false
    this.dim = 0
  }
}

/** 进程内单例（embed.ts 的 initKbStatus / store.ts 的 search 共用） */
export const flatIndex = new FlatIndexImpl()

/** 懒加载入口（从 index.ts 的 void initKbStatus() 调，非阻塞） */
export function initFlatIndex(): void {
  try {
    flatIndex.load()
  } catch (e) {
    // 非致命：加载失败走纯词法兜底（降级链）
    console.warn('[flat-index] load failed, degrade to FTS', e)
  }
}
