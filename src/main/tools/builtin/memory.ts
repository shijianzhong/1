import { z } from 'zod'
import { registerTool } from '../registry'
import { getL3, saveL3, searchL3 } from '../../storage/memory/l3'
import type { ToolContext } from '../registry'

// —— 内置记忆工具（§三之三 J + 铁律21）——
// L3 走 memory_recall/memory_search/memory_retain 工具按需检索（不硬塞 prompt）。
// userId 从 toolCtx 取（单用户默认 'local'）。

const DEFAULT_USER_ID = 'local'

function userIdOf(ctx: ToolContext): string {
  return DEFAULT_USER_ID // 单用户桌面版无隔离（§5.2.2）
}

/** 注册内置记忆工具 */
export function registerMemoryTools(): void {
  registerTool(
    'memory_recall',
    '按 key 精确取回长期记忆',
    z.object({ key: z.string().describe('记忆键名') }),
    async (args, ctx) => {
      const { key } = args as { key: string }
      const value = getL3(userIdOf(ctx), key)
      return value ? { key, value } : { key, value: null, note: '未找到' }
    },
  )

  registerTool(
    'memory_search',
    '按关键词模糊检索长期记忆',
    z.object({
      query: z.string().describe('检索关键词'),
      limit: z.number().optional().describe('返回上限，默认 5'),
    }),
    async (args, ctx) => {
      const { query, limit } = args as { query: string; limit?: number }
      return searchL3(userIdOf(ctx), query, limit ?? 5)
    },
  )

  registerTool(
    'memory_retain',
    '写入/更新长期记忆（key-value）',
    z.object({
      key: z.string().describe('记忆键名'),
      value: z.string().describe('记忆内容'),
    }),
    async (args, ctx) => {
      const { key, value } = args as { key: string; value: string }
      saveL3(userIdOf(ctx), key, value)
      return { ok: true, key }
    },
  )
}
