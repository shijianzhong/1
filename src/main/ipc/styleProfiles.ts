import { z } from 'zod'
import type { StyleProfile } from '@shared/types'
import { withHandler } from './handler'
import {
  getStyleProfile,
  listStyleProfiles,
  removeStyleProfile,
  saveStyleProfile,
} from '../storage/models'
import { StyleProfileInputSchema } from '../config'

// —— 风格画像 IPC（内容生产 §2.3）——
// 入参 Zod 校验：IPC 边界不做隐式 as 断言，畸形参数在入口处结构化报错（仿 sessions.ts）。

const IdSchema = z.string().min(1)

export function registerStyleProfilesHandlers(): void {
  withHandler<StyleProfile[]>('styleProfiles:list', () => listStyleProfiles())
  withHandler<StyleProfile | null>('styleProfiles:get', (_e, id) =>
    getStyleProfile(IdSchema.parse(id)),
  )
  withHandler<StyleProfile>('styleProfiles:save', (_e, input) =>
    saveStyleProfile(StyleProfileInputSchema.parse(input)),
  )
  withHandler<void>('styleProfiles:remove', (_e, id) =>
    removeStyleProfile(IdSchema.parse(id)),
  )
}
