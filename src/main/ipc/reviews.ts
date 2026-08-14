import { z } from 'zod'
import type { ReviewRecord } from '@shared/types'
import { withHandler } from './handler'
import {
  createReview,
  getLatestReviewForAsset,
  getReview,
  listReviews,
  removeReview,
} from '../storage/models'
import { ReviewRecordInputSchema } from '../config'

// —— Review 档案 IPC（内容生产 §2.3）——
// 入参 Zod 校验：IPC 边界不做隐式 as 断言，畸形参数在入口处结构化报错（仿 sessions.ts）。

const IdSchema = z.string().min(1)

const ListReviewsSchema = z
  .object({
    assetType: z.string().optional(),
    assetId: z.string().optional(),
    userId: z.string().optional(),
  })
  .optional()

const LatestForAssetSchema = z.object({
  assetType: z.string().min(1),
  assetId: z.string().min(1),
})

export function registerReviewsHandlers(): void {
  withHandler<ReviewRecord[]>('reviews:list', (_e, optsRaw) => {
    const opts = ListReviewsSchema.parse(optsRaw)
    return listReviews({
      assetType: opts?.assetType,
      assetId: opts?.assetId,
      userId: opts?.userId,
    })
  })
  withHandler<ReviewRecord | null>('reviews:get', (_e, id) => getReview(IdSchema.parse(id)))
  withHandler<ReviewRecord>('reviews:create', (_e, input) =>
    createReview(ReviewRecordInputSchema.parse(input)),
  )
  withHandler<ReviewRecord | null>('reviews:latestForAsset', (_e, payload) => {
    const p = LatestForAssetSchema.parse(payload)
    return getLatestReviewForAsset(p.assetType, p.assetId)
  })
  withHandler<void>('reviews:remove', (_e, id) => removeReview(IdSchema.parse(id)))
}
