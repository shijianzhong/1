import { z } from 'zod'
import type { Topic, TopicStatus } from '@shared/types'
import { withHandler } from './handler'
import {
  createTopic,
  getTopic,
  listTopics,
  removeTopic,
  updateTopic,
} from '../storage/models'
import { TopicInputSchema } from '../config'

// —— 选题库 IPC（内容生产 §2.3）——
// 入参 Zod 校验：IPC 边界不做隐式 as 断言，畸形参数在入口处结构化报错（仿 sessions.ts）。

const IdSchema = z.string().min(1)

const ListTopicsSchema = z
  .object({
    status: z.string().optional(),
    direction: z.string().optional(),
    userId: z.string().optional(),
  })
  .optional()

const TopicPatchSchema = z
  .object({
    title: z.string().min(1).optional(),
    direction: z.string().optional(),
    status: z.enum(['pending', 'researching', 'producing', 'published', 'archived']).optional(),
    recommendation: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    meta: TopicInputSchema.shape.meta.optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict()

const UpdateTopicSchema = z.object({
  id: z.string().min(1),
  patch: TopicPatchSchema,
})

export function registerTopicsHandlers(): void {
  withHandler<Topic[]>('topics:list', (_e, optsRaw) => {
    const opts = ListTopicsSchema.parse(optsRaw)
    return listTopics({
      status: opts?.status as TopicStatus | undefined,
      direction: opts?.direction,
      userId: opts?.userId,
    })
  })
  withHandler<Topic | null>('topics:get', (_e, id) => getTopic(IdSchema.parse(id)))
  withHandler<Topic>('topics:create', (_e, input) => createTopic(TopicInputSchema.parse(input)))
  withHandler<Topic | null>('topics:update', (_e, payload) => {
    const p = UpdateTopicSchema.parse(payload)
    return updateTopic(p.id, p.patch)
  })
  withHandler<void>('topics:remove', (_e, id) => removeTopic(IdSchema.parse(id)))
}
