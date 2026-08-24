import { getDb } from '../db'
import type { L1Summary, LlmMessage } from '@shared/types'
import { logger } from '../../logger'
import { messagesTokenCount } from '../../llm/token-count'

// —— L1 会话内滚动压缩（§三之三 D + 铁律21）——
// L1 是会话级 LLM 摘要存 SQLite，与 agent 运行时 compaction 不同层级
// （compaction 是窗口截断防超 token，L1 在前先压缩存档）。
// 触发：单会话消息 token 超阈值时压缩前文成 summary。
// 受阻先用简单截断兜底（§三之三 D 注）。

/** L1 触发阈值（按消息 token 估算，~24k 触发压缩） */
const L1_TRIGGER_TOKENS = 24_000
/** 压缩后保留的最近窗口消息数 */
const L1_RECENT_WINDOW = 8

/** 取会话的 L1 摘要 */
export function getL1(sessionId: string): L1Summary | null {
  const row = getDb()
    .prepare('SELECT session_id, summary, summarized_up_to, ts FROM memory_l1 WHERE session_id = ?')
    .get(sessionId) as
    | { session_id: string; summary: string; summarized_up_to: string | null; ts: number }
    | undefined
  if (!row) return null
  return {
    sessionId: row.session_id,
    summary: row.summary,
    summarizedUpTo: row.summarized_up_to ?? undefined,
    ts: row.ts,
  }
}

/** 存/更新 L1 摘要 */
export function saveL1(input: L1Summary): void {
  getDb()
    .prepare(
      `INSERT INTO memory_l1 (session_id, summary, summarized_up_to, ts)
       VALUES (@sessionId, @summary, @summarizedUpTo, @ts)
       ON CONFLICT(session_id) DO UPDATE SET
         summary = excluded.summary,
         summarized_up_to = excluded.summarized_up_to,
         ts = excluded.ts`,
    )
    .run({
      sessionId: input.sessionId,
      summary: input.summary,
      summarizedUpTo: input.summarizedUpTo ?? null,
      ts: input.ts,
    })
}

/**
 * 压缩会话前文。若提供 compressFn 则用 LLM 压缩，否则简单截断兜底。
 * @param messages 该会话全部消息
 * @param compressFn LLM 压缩函数（输入待压缩文本，输出摘要）；不传则截断兜底
 * @returns { summary, recentWindow } summary 注入首条 system msg，recentWindow 是最近原文
 */
export async function maybeCompressL1(
  sessionId: string,
  messages: LlmMessage[],
  compressFn?: (text: string) => Promise<string>,
): Promise<{ summary: string | null; recentWindow: LlmMessage[] }> {
  // 未达阈值：不压缩，全部走原文
  const totalTokens = messagesTokenCount(messages)
  if (totalTokens < L1_TRIGGER_TOKENS) {
    return { summary: null, recentWindow: messages }
  }

  const existing = getL1(sessionId)
  // 待压缩 = 最近窗口之前的消息（已压过的跳过 summarizedUpTo 之前的）
  const toCompress = messages.slice(
    0,
    messages.length - L1_RECENT_WINDOW,
  )
  const recentWindow = messages.slice(-L1_RECENT_WINDOW)

  if (toCompress.length === 0) {
    return { summary: existing?.summary ?? null, recentWindow }
  }

  const textToCompress = toCompress
    .map((m) => {
      const text =
        typeof m.content === 'string'
          ? m.content
          : m.content
              .map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? b.content : ''))
              .filter(Boolean)
              .join(' ')
      return `${m.role}: ${text}`
    })
    .join('\n')

  let summary: string
  if (compressFn) {
    try {
      summary = await compressFn(textToCompress)
    } catch (error) {
      logger.warn(`[l1] LLM 压缩失败，降级截断`, error)
      // 降级：取前 N 字作摘要
      summary = textToCompress.slice(0, 500) + '…'
    }
  } else {
    // 简单截断兜底（§三之三 D 注）
    summary = textToCompress.slice(0, 500) + '…'
  }

  const lastCompressedId = toCompress[toCompress.length - 1]
    ? String(toCompress.length - 1)
    : undefined
  saveL1({
    sessionId,
    summary,
    summarizedUpTo: lastCompressedId,
    ts: Date.now(),
  })

  return { summary, recentWindow }
}

/**
 * 构建注入 messages 的 L1 system msg（§三之三 D：首条 system msg）。
 * @returns messages 数组，首条为摘要 system msg（若有），后接最近窗口原文
 */
export function buildL1Messages(
  sessionId: string,
  recentWindow: LlmMessage[],
): LlmMessage[] {
  const l1 = getL1(sessionId)
  if (!l1?.summary) return recentWindow
  // L1 摘要作为首条 user msg（含【早期对话摘要】标记）
  return [
    { role: 'user', content: `【早期对话摘要】\n${l1.summary}` },
    ...recentWindow,
  ]
}

/** 删除会话的 L1 */
export function removeL1(sessionId: string): void {
  getDb().prepare('DELETE FROM memory_l1 WHERE session_id = ?').run(sessionId)
}

/** 列出所有会话的 L1 摘要（管理页用，按 ts 倒序） */
export function listL1(): L1Summary[] {
  const rows = getDb()
    .prepare(
      'SELECT session_id, summary, summarized_up_to, ts FROM memory_l1 ORDER BY ts DESC',
    )
    .all() as Array<{
    session_id: string
    summary: string
    summarized_up_to: string | null
    ts: number
  }>
  return rows.map((r) => ({
    sessionId: r.session_id,
    summary: r.summary,
    summarizedUpTo: r.summarized_up_to ?? undefined,
    ts: r.ts,
  }))
}
