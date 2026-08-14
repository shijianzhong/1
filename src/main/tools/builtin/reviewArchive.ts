import { z } from 'zod'
import { registerTool } from '../registry'
import { createReview } from '../../storage/models'
import type { ReviewNotes } from '@shared/types'

// —— Review 档案落库（内容生产 §2.2，新建：SQLite 写）——
// A6 reviewer 内闭环收敛后，把最终 review（5维打分+对标对比+改点+AI腔命中）落 reviews 表。
// 读走 reviews.ts（listReviews/getLatestReviewForAsset），写经本工具。
// 工具不经 IPC，agent 自动从 registry 取。错误返回 JSON 不抛（铁律11）。

export function registerReviewArchiveTools(): void {
  registerTool(
    'review_archive_save',
    '把一次 review 结论落进 review 档案库（SQLite）。A6 reviewer 内闭环收敛后调用：写明被审资产（选题/文章 slug）、爆款总分 0-10、结论（可发/需返工/推倒重写）、5维打分+对标差距+改点清单+AI腔命中+发布前微调。落库后前端"Review 档案"页可查历史，也用于后续迭代风格画像。',
    z.object({
      assetType: z.enum(['article', 'topic', 'agent', 'capability']).describe('被审资产类型'),
      assetId: z.string().describe('被审资产 id（选题 id / 文章 slug / agent id）'),
      score: z.number().min(0).max(10).describe('爆款总分 0-10'),
      verdict: z.enum(['可发', '需返工', '推倒重写']).describe('结论'),
      notes: z
        .object({
          dimensions: z
            .object({
              title: z.number().min(0).max(2).optional(),
              opening: z.number().min(0).max(2).optional(),
              punchline: z.number().min(0).max(2).optional(),
              authenticity: z.number().min(0).max(2).optional(),
              interaction: z.number().min(0).max(2).optional(),
            })
            .optional(),
          total: z.number().optional(),
          benchmark: z.string().optional().describe('对标账号差距'),
          revisionPoints: z.array(z.string()).optional().describe('改点清单（按优先级）'),
          aiCavityHits: z
            .array(
              z.object({
                sentence: z.string(),
                type: z.enum(['self_invented_term', 'english_connection_misuse']),
                marker: z.string().optional(),
                suggestion: z.string().optional(),
              }),
            )
            .optional(),
          finalTweaks: z.array(z.string()).optional().describe('发布前微调建议'),
        })
        .optional(),
    }),
    async (args) => {
      const input = args as {
        assetType: string
        assetId: string
        score: number
        verdict: '可发' | '需返工' | '推倒重写'
        notes?: ReviewNotes
      }
      try {
        const record = createReview({
          assetType: input.assetType,
          assetId: input.assetId,
          score: input.score,
          verdict: input.verdict,
          notes: input.notes,
        })
        return { ok: true, reviewId: record.id, verdict: record.verdict }
      } catch (e) {
        return {
          ok: false,
          error: 'write_failed',
          messageKey: 'errors.tools.review_save_failed',
          hint: e instanceof Error ? e.message : String(e),
        }
      }
    },
  )
}
