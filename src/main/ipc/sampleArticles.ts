import { z } from 'zod'
import type { SampleArticle } from '@shared/types'
import { withHandler } from './handler'
import {
  getSampleArticle,
  listSampleArticles,
  removeSampleArticle,
  saveSampleArticle,
} from '../storage/models'
import { SampleArticleInputSchema } from '../config'

// —— 样文 IPC（内容生产 §2.3，目录化存储）——
// 入参 Zod 校验：IPC 边界不做隐式 as 断言，畸形参数在入口处结构化报错（仿 sessions.ts）。

const IdSchema = z.string().min(1)

export function registerSampleArticlesHandlers(): void {
  withHandler<SampleArticle[]>('sampleArticles:list', () => listSampleArticles())
  withHandler<SampleArticle | null>('sampleArticles:get', (_e, id) =>
    getSampleArticle(IdSchema.parse(id)),
  )
  withHandler<SampleArticle>('sampleArticles:save', (_e, input) =>
    saveSampleArticle(SampleArticleInputSchema.parse(input)),
  )
  withHandler<void>('sampleArticles:remove', (_e, id) =>
    removeSampleArticle(IdSchema.parse(id)),
  )
}
