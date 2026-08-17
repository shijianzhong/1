import { z } from 'zod'
import { registerTool } from '../registry'
import { getL3, listL3Keys, removeL3, saveL3, searchL3 } from '../../storage/memory/l3'
import type { ToolContext } from '../registry'

// —— 内置记忆工具（§三之三 J + 铁律21）——
// L3 走 memory_recall/memory_search/memory_retain 工具按需检索（不硬塞 prompt）。
// userId 从 toolCtx 取（单用户默认 'local'）。
//
// 「让 L3 活起来」的关键在两点：
//   1. description 行为导向——明确告诉 LLM 何时该记、何时该取（否则工具形同虚设）。
//   2. memory_retain 智能拆分——把一段价值文本拆成原子记忆逐条入库，
//      避免「一大段塞一个 key」导致 FTS 检索粒度太粗、key 不可寻址。

const DEFAULT_USER_ID = 'local'

function userIdOf(_ctx: ToolContext): string {
  return DEFAULT_USER_ID // 单用户桌面版无隔离（§5.2.2）
}

/** 记忆类别（key 命名空间前缀，便于按域检索与人工管理） */
const CATEGORIES = ['preference', 'identity', 'project', 'goal', 'fact'] as const
type Category = (typeof CATEGORIES)[number]

/**
 * 把一段价值文本拆成原子记忆（一句话一条）。
 * 按换行、中英文句号/分号/感叹号切分；过滤过短碎片；保留有序。
 */
export function splitAtomicMemories(text: string): string[] {
  return text
    .split(/[\n\r]+|[。！？；!?;]+/)
    .map((s) => s.trim().replace(/^[，,、\s]+|[，,、\s]+$/g, ''))
    .filter((s) => [...s].length >= 4) // 过短（<4 字）不成记忆，丢弃
}

/** key 最大长度（含类别前缀 + 原子序号），防 LLM 生成超长 key 撑爆索引（断言 4.5） */
const KEY_MAX = 200
/** 单条 value 最大长度，防 LLM 把整段长文塞一个 key 撑爆 FTS 与 LIKE 检索（断言 4.5） */
const VALUE_MAX = 8_000
/** 检索词最大长度，防超长 query 生成大量 OR 项拖慢 FTS / 全表 LIKE（断言 4.5） */
const QUERY_MAX = 500

/** 注册内置记忆工具 */
export function registerMemoryTools(): void {
  registerTool(
    'memory_recall',
    '按 key 精确取回一条长期记忆。仅当你确切知道 key 时用；不确定 key 或按内容找，用 memory_search。',
    z.object({ key: z.string().max(KEY_MAX).describe('记忆键名（含类别前缀，如 preference_运动）') }),
    async (args, ctx) => {
      const { key } = args as { key: string }
      const value = getL3(userIdOf(ctx), key)
      return value ? { key, value } : { key, value: null, note: '未找到，可用 memory_search 按内容检索' }
    },
  )

  registerTool(
    'memory_search',
    '语义检索长期记忆。当用户提到「我之前说过/我喜欢/你还记得」等引用过往信息，或回答需要结合用户偏好、身份、项目背景时主动调用，传入相关关键词（如「运动」「职业」「技术栈」）。',
    z.object({
      query: z.string().max(QUERY_MAX).describe('检索关键词（越贴近记忆内容的措辞越准，可多词）'),
      limit: z.number().optional().describe('返回上限，默认 5'),
    }),
    async (args, ctx) => {
      const { query, limit } = args as { query: string; limit?: number }
      const hits = searchL3(userIdOf(ctx), query, limit ?? 5)
      return hits.length > 0 ? hits : { note: '无相关记忆', query }
    },
  )

  registerTool(
    'memory_retain',
    '把用户透露的稳定信息写入长期记忆。仅记「跨会话仍有价值」的事实：稳定偏好（如「喜欢晨跑」）、身份信息（职业/所在地/经历）、项目约定（技术栈/规范）、长期目标。不要记一次性、易变或仅当前会话相关的内容；也不要记称呼/角色/偏好语种——那是「个人档案」字段，应走 propose_persona 更新（否则设置页不同步）。会自动拆成原子记忆逐条入库。',
    z.object({
      category: z
        .enum(CATEGORIES)
        .describe('记忆类别：preference 偏好 / identity 身份 / project 项目约定 / goal 目标 / fact 其它事实'),
      key: z
        .string()
        .max(KEY_MAX)
        .describe('记忆主题（简短中文词，如「运动偏好」「职业」「技术栈」；会自动加类别前缀）'),
      value: z
        .string()
        .max(VALUE_MAX)
        .describe('要记住的内容，一条一个事实；多条用换行或句号分隔，系统会自动拆分成原子记忆'),
    }),
    async (args, ctx) => {
      const { category, key, value } = args as { category: Category; key: string; value: string }
      const uid = userIdOf(ctx)
      const atoms = splitAtomicMemories(value)
      if (atoms.length === 0) {
        // 铁律11：工具失败返回错误 JSON 不抛
        return { ok: false, error: 'empty_memory', hint: '内容过短或为空，未写入' }
      }
      const baseKey = `${category}_${key.trim()}`
      const written: string[] = []
      if (atoms.length === 1) {
        saveL3(uid, baseKey, atoms[0])
        written.push(baseKey)
      } else {
        // 多条原子记忆：同主题按序号落多个 key，均可单独检索/更新
        atoms.forEach((atom, i) => {
          const k = `${baseKey}_${i + 1}`
          saveL3(uid, k, atom)
          written.push(k)
        })
      }
      return { ok: true, keys: written, count: written.length }
    },
  )

  registerTool(
    'memory_forget',
    '删除一条长期记忆（按 key）。仅在用户明确要求「忘掉/删除」某条记忆时用。可先用 memory_search 找到 key。',
    z.object({ key: z.string().describe('要删除的记忆键名') }),
    async (args, ctx) => {
      const { key } = args as { key: string }
      removeL3(userIdOf(ctx), key)
      return { ok: true, key }
    },
  )
}

/** 列出当前全部 L3 key（供记忆策略指令提示 LLM 已有哪些记忆，避免重复写入） */
export function listMemoryKeysForPrompt(): string[] {
  return listL3Keys(DEFAULT_USER_ID)
}
