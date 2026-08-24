// —— 记忆管理页 IPC handlers（§三之三 D + 铁律21）——
//
// memory:list        —— 读取 L1/L2/L3 当前数据（单用户 'local'），供管理页展示
// memory:l3:add      —— 新增/覆盖 L3 fact（saveL3 upsert，主表+FTS 同事务）
// memory:l3:update   —— 改 L3 fact 文本（同 key upsert）
// memory:l3:remove   —— 删 L3 fact（主表+FTS 同事务）
// memory:l2:update   —— 改单条 L2 摘要文本
// memory:l2:remove   —— 删单条 L2
// memory:l1:remove   —— 删单条 L1（L1 为 LLM 滚动压缩产物，管理页只读+删，不提供编辑）
//
// 入参 Zod 校验：畸形参数在入口处结构化报错。ZodError 原生无 messageKey，此处捕获后
// 转 IpcErrorThrow('errors:memory.invalid_input') 让渲染层按 i18n key 翻译（铁律 T2：不硬编码中文）。

import { z, ZodError } from 'zod'
import { withHandler } from './handler'
import { IpcErrorThrow } from '@shared/types'
import { listL1, removeL1 } from '../storage/memory/l1'
import { listL2, updateL2Digest, removeL2Entry } from '../storage/memory/l2'
import { listL3, saveL3, removeL3 } from '../storage/memory/l3'

/** 单用户（与全仓记忆层一致，user_id 默认 'local'） */
const USER = 'local'

const L3KeySchema = z.string().min(1).max(200)
const L3ValueSchema = z.string().min(1).max(20000)
const DigestSchema = z.string().min(1).max(5000)
const SessionIdSchema = z.string().min(1)
const TsSchema = z.number().int().positive()

/** Zod 校验入口：ZodError 转为带 i18n messageKey 的结构化错误 */
function parseInput<T>(schema: z.ZodType<T>, raw: unknown): T {
  try {
    return schema.parse(raw)
  } catch (error) {
    if (error instanceof ZodError) throw new IpcErrorThrow('errors:memory.invalid_input')
    throw error
  }
}

export function registerMemoryHandlers(): void {
  withHandler('memory:list', (): import('@shared/types').MemorySnapshot => ({
    l1: listL1(),
    l2: listL2(USER),
    l3: listL3(USER),
  }))

  withHandler('memory:l3:add', (_e, raw) => {
    const { key, value } = parseInput(
      z.object({ key: L3KeySchema, value: L3ValueSchema }),
      raw,
    )
    saveL3(USER, key, value)
    return { ok: true as const }
  })

  withHandler('memory:l3:update', (_e, raw) => {
    const { key, value } = parseInput(
      z.object({ key: L3KeySchema, value: L3ValueSchema }),
      raw,
    )
    // 同 key upsert：改文本即覆盖；改 key 身份由前端走 remove+add
    saveL3(USER, key, value)
    return { ok: true as const }
  })

  withHandler('memory:l3:remove', (_e, raw) => {
    const { key } = parseInput(z.object({ key: L3KeySchema }), raw)
    removeL3(USER, key)
    return { ok: true as const }
  })

  withHandler('memory:l2:update', (_e, raw) => {
    const { sessionId, ts, digest } = parseInput(
      z.object({ sessionId: SessionIdSchema.optional(), ts: TsSchema, digest: DigestSchema }),
      raw,
    )
    updateL2Digest(USER, sessionId, ts, digest)
    return { ok: true as const }
  })

  withHandler('memory:l2:remove', (_e, raw) => {
    const { sessionId, ts } = parseInput(
      z.object({ sessionId: SessionIdSchema.optional(), ts: TsSchema }),
      raw,
    )
    removeL2Entry(USER, sessionId, ts)
    return { ok: true as const }
  })

  withHandler('memory:l1:remove', (_e, raw) => {
    const { sessionId } = parseInput(z.object({ sessionId: SessionIdSchema }), raw)
    removeL1(sessionId)
    return { ok: true as const }
  })
}
