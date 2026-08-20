import { describe, expect, it } from 'vitest'
import { rankedChannel, rrfFuse, rrfFuseTopN } from './rrf'

// —— RRF 倒数排名融合（docs/VECTOR_KB_PLAN.md §六:176-179）——
describe('rrf 融合', () => {
  it('两路融合：按 rank Σ 1/(k+rank) 排序，去重', () => {
    // 向量路：[A, B, C]（rank 1,2,3）
    // 词法路：[B, A, D]（rank 1,2,3）
    const vec = rankedChannel(['A', 'B', 'C'])
    const lex = rankedChannel(['B', 'A', 'D'])
    const fused = rrfFuseTopN([vec, lex], 4, 60)
    const ids = fused.map((f) => f.id)
    // A: 1/(60+1) + 1/(60+2) = 两路都靠前 → 最高
    // B: 1/(60+2) + 1/(60+1) → 与 A 对称，同分
    // D: 只在词法路 rank3 → 最低
    expect(ids).toContain('D')
    const dScore = fused.find((f) => f.id === 'D')!.score
    const aScore = fused.find((f) => f.id === 'A')!.score
    expect(aScore).toBeGreaterThan(dScore)
  })

  it('NULL-vec 块只在词法路有 rank 仍参与排名（公平，§六:178）', () => {
    // 向量路空（NULL-vec 块不进向量候选）+ 词法路 [X, Y]
    const lex = rankedChannel(['X', 'Y'])
    const fused = rrfFuse([lex])
    expect(fused.get('X')).toBeGreaterThan(fused.get('Y')!)
    expect(fused.get('X')).toBeCloseTo(1 / 61, 5)
  })

  it('默认 k=60', () => {
    const ch = rankedChannel(['A'])
    const fused = rrfFuse([ch])
    // 1/(60+1)
    expect(fused.get('A')).toBeCloseTo(1 / 61, 5)
  })

  it('rrfFuseTopN 截断 topN', () => {
    const a = rankedChannel(['A', 'B', 'C', 'D', 'E'])
    const b = rankedChannel(['C', 'A', 'E', 'B', 'D'])
    const fused = rrfFuseTopN([a, b], 3)
    expect(fused.length).toBe(3)
    // 结果降序
    expect(fused[0].score).toBeGreaterThanOrEqual(fused[1].score)
    expect(fused[1].score).toBeGreaterThanOrEqual(fused[2].score)
  })

  it('rankedChannel 去重保首（同 id 多次出现取首次 rank）', () => {
    const ch = rankedChannel(['A', 'B', 'A', 'C'])
    expect(ch.get('A')).toBe(1) // 首次出现位置 1
    expect(ch.get('B')).toBe(2)
    expect(ch.get('C')).toBe(4)
  })

  it('空 channels → 空结果', () => {
    expect(rrfFuseTopN([])).toEqual([])
    expect(rrfFuse([]).size).toBe(0)
  })
})
