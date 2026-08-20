// —— RRF 倒数排名融合（docs/VECTOR_KB_PLAN.md §六:176-179）——
//
// hybrid 检索的标准融合法：score = Σ 1/(k + rank)，按各路召回的 rank 融合，
// 去重按 id。与分值尺度无关 → 向量 cosine（0~1）与词法 BM25（可能 >1）可公平并列。
//
// 对 vec IS NULL 的离线块天然公平（§六:178）：NULL-vec 块根本不进向量候选集，
// 故 RRF 只计其词法 rank 1/(k+rank_lex)，缺项路不产生分值、无尺度不公。
// 比 weighted sum 更简单更标准，是 hybrid 检索业界默认做法。

/** 单路召回结果：一个 id → rank 的有序映射（rank 从 1 起，按该路 score 降序排） */
export type RrfChannel = Map<string, number>

/** 单条融合后结果 */
export interface RrfFused {
  id: string
  score: number
}

/**
 * RRF 融合：多路召回的 rank 合并成统一 score。
 *
 * @param channels 各路召回（每路内部已按 score 降序，rank=1 是该路最佳）
 * @param k 平滑常数，默认 60（业界标准值）；越大越平滑各路差异
 * @returns Map<id, score>，按 score 降序需调用方 rrfFuseTopN 截断
 */
export function rrfFuse(channels: RrfChannel[], k = 60): Map<string, number> {
  const fused = new Map<string, number>()
  for (const channel of channels) {
    for (const [id, rank] of channel) {
      // rank 从 1 起；rank=0 视为未排名（防御，不应出现）
      const r = rank > 0 ? rank : 1
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + r))
    }
  }
  return fused
}

/**
 * 融合 + 排序 + Top-N 截断。
 *
 * @param channels 各路召回
 * @param topN 返回前 N 条（默认全部）
 * @param k RRF 平滑常数
 * @returns 按 score 降序的 {id, score} 数组
 */
export function rrfFuseTopN(
  channels: RrfChannel[],
  topN?: number,
  k = 60,
): RrfFused[] {
  const fused = rrfFuse(channels, k)
  const arr: RrfFused[] = []
  for (const [id, score] of fused) arr.push({ id, score })
  // 降序：score 大优先；同分按 id 稳定排序（确定性，便于测试）
  arr.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : 1))
  return topN != null && topN >= 0 ? arr.slice(0, topN) : arr
}

/**
 * 把一个已按 score 降序的 id 数组转成 RrfChannel（rank 从 1 起）。
 * 各路召回（向量 Top-k、词法 BM25 Top-k）拿到的就是有序 id 列表，
 * 调此函数赋 rank 后喂给 rrfFuseTopN。
 */
export function rankedChannel(orderedIds: string[]): RrfChannel {
  const m = new Map<string, number>()
  orderedIds.forEach((id, i) => {
    if (!m.has(id)) m.set(id, i + 1) // 同 id 取首次出现位置（去重保首）
  })
  return m
}
