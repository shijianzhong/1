import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import type { ReviewRecord, ReviewNotes } from '@shared/types'

// —— Review 档案 CRUD（SQLite reviews 表，v8 迁移；docs/CONTENT_PIPELINE_PLAN.md §2.3）——
// 仿 sessions.ts 范式。notes 走 JSON 列。

export function createReview(input: {
  assetType: string
  assetId: string
  score: number
  verdict: '可发' | '需返工' | '推倒重写'
  userId?: string
  notes?: ReviewNotes
}): ReviewRecord {
  const review: ReviewRecord = {
    id: randomUUID(),
    userId: input.userId ?? 'local',
    assetType: input.assetType,
    assetId: input.assetId,
    score: input.score,
    verdict: input.verdict,
    notes: input.notes,
    createdAt: Date.now(),
  }
  getDb()
    .prepare(
      `INSERT INTO reviews (id, user_id, asset_type, asset_id, score, verdict, notes, created_at)
       VALUES (@id, @userId, @assetType, @assetId, @score, @verdict, @notes, @createdAt)`,
    )
    .run({
      ...review,
      notes: review.notes ? JSON.stringify(review.notes) : null,
    })
  return review
}

export function listReviews(opts?: {
  userId?: string
  assetType?: string
  assetId?: string
}): ReviewRecord[] {
  const conditions: string[] = ['user_id = @userId']
  const params: Record<string, unknown> = { userId: opts?.userId ?? 'local' }
  if (opts?.assetType) {
    conditions.push('asset_type = @assetType')
    params.assetType = opts.assetType
  }
  if (opts?.assetId) {
    conditions.push('asset_id = @assetId')
    params.assetId = opts.assetId
  }
  return getDb()
    .prepare(
      `SELECT id, user_id as userId, asset_type as assetType, asset_id as assetId,
              score, verdict, notes, created_at as createdAt
       FROM reviews WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
    )
    .all(params)
    .map((row) => deserializeReview(row)) as ReviewRecord[]
}

export function getReview(id: string): ReviewRecord | null {
  const row = getDb()
    .prepare(
      `SELECT id, user_id as userId, asset_type as assetType, asset_id as assetId,
              score, verdict, notes, created_at as createdAt
       FROM reviews WHERE id = ?`,
    )
    .get(id) as ReviewRecord | undefined
  return row ? deserializeReview(row) : null
}

export function removeReview(id: string): void {
  getDb().prepare('DELETE FROM reviews WHERE id = ?').run(id)
}

/** 取某资产最近一次 review（A6 内闭环收敛后写，前端展示用） */
export function getLatestReviewForAsset(assetType: string, assetId: string): ReviewRecord | null {
  const row = getDb()
    .prepare(
      `SELECT id, user_id as userId, asset_type as assetType, asset_id as assetId,
              score, verdict, notes, created_at as createdAt
       FROM reviews WHERE asset_type = ? AND asset_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(assetType, assetId) as ReviewRecord | undefined
  return row ? deserializeReview(row) : null
}

/** 反序列化：notes JSON 列 → 对象 */
function deserializeReview(row: unknown): ReviewRecord {
  const r = row as Record<string, unknown>
  return {
    ...(r as unknown as ReviewRecord),
    notes: r.notes ? (JSON.parse(r.notes as string) as ReviewNotes) : undefined,
  }
}
