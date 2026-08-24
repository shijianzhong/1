import { getDb } from '../db'
import type { L2Digest } from '@shared/types'
import { logger } from '../../logger'

// —— L2 跨会话精炼（§三之三 D + 铁律21）——
// 会话结束时 LLM 精炼本会话要点存 memory_l2，注入 persona（限长 1500 字）
// 作【该用户历史对话摘要】段。

const L2_MAX_INJECT_CHARS = 1500
const L2_RECENT_DIGESTS = 10
/** L2 软上限：超出后删除最旧条目，防无限增长（观察点收口） */
const L2_SOFT_CAP = 50

/** 取用户的 L2 摘要列表（最近 N 条） */
export function listL2(userId = 'local'): L2Digest[] {
  return getDb()
    .prepare(
      'SELECT user_id as userId, session_id as sessionId, digest, ts FROM memory_l2 WHERE user_id = ? ORDER BY ts DESC LIMIT ?',
    )
    .all(userId, L2_RECENT_DIGESTS) as L2Digest[]
}

/** 存 L2 摘要，并按软上限修剪最旧条目 */
export function saveL2(input: L2Digest): void {
  const db = getDb()
  db.prepare(
    'INSERT INTO memory_l2 (user_id, session_id, digest, ts) VALUES (@userId, @sessionId, @digest, @ts)',
  ).run({
    userId: input.userId,
    sessionId: input.sessionId ?? null,
    digest: input.digest,
    ts: input.ts,
  })
  // 软上限修剪：保留最新 L2_SOFT_CAP 条，删超出部分（按 ts 升序删最旧）
  db.prepare(
    `DELETE FROM memory_l2 WHERE user_id = @userId AND rowid NOT IN (
       SELECT rowid FROM memory_l2 WHERE user_id = @userId ORDER BY ts DESC LIMIT @cap
     )`,
  ).run({ userId: input.userId, cap: L2_SOFT_CAP })
}

/**
 * 精炼会话为 L2 摘要并存盘。
 * @param compressFn LLM 精炼函数（输入会话文本，输出摘要）
 */
export async function refineL2(
  userId: string,
  sessionId: string,
  messages: import('@shared/types').LlmMessage[],
  compressFn: (text: string) => Promise<string>,
): Promise<L2Digest | null> {
  const text = messages
    .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : '[blocks]'}`)
    .join('\n')
  if (!text.trim()) return null

  let digest: string
  try {
    digest = await compressFn(text)
  } catch (error) {
    logger.warn(`[l2] 精炼失败，跳过`, error)
    return null
  }

  const entry: L2Digest = {
    userId,
    sessionId,
    digest,
    ts: Date.now(),
  }
  saveL2(entry)
  return entry
}

/**
 * 构建 L2 注入段（§三之三 D：【该用户历史对话摘要】）。
 * 限长 1500 字，超出截断保留最近条目。
 */
export function buildL2Injection(userId = 'local'): string {
  const digests = listL2(userId)
  if (digests.length === 0) return ''

  // 按时间正序拼接（最早的在前，最近的在后）
  const ordered = [...digests].reverse()
  const lines = ordered.map((d) => `- ${d.digest}`)
  let text = `【该用户历史对话摘要】\n${lines.join('\n')}`

  if (text.length > L2_MAX_INJECT_CHARS) {
    // 从最早的开始截断，保留最近的
    while (text.length > L2_MAX_INJECT_CHARS && ordered.length > 1) {
      ordered.shift()
      text = `【该用户历史对话摘要】\n${ordered
        .map((d) => `- ${d.digest}`)
        .join('\n')}`
    }
    if (text.length > L2_MAX_INJECT_CHARS) {
      text = text.slice(0, L2_MAX_INJECT_CHARS) + '…'
    }
  }
  return text
}

/** 删除用户所有 L2 */
export function removeL2(userId = 'local'): void {
  getDb().prepare('DELETE FROM memory_l2 WHERE user_id = ?').run(userId)
}

/**
 * 改单条 L2 摘要文本（管理页编辑用）。
 * 定位：(user_id, session_id, ts)；sessionId 缺失按空串归一（COALESCE 双端）。
 */
export function updateL2Digest(
  userId: string,
  sessionId: string | undefined,
  ts: number,
  digest: string,
): void {
  getDb()
    .prepare(
      `UPDATE memory_l2 SET digest = ?
       WHERE user_id = ? AND COALESCE(session_id, '') = COALESCE(?, '') AND ts = ?`,
    )
    .run(digest, userId, sessionId ?? '', ts)
}

/** 删单条 L2（定位同上） */
export function removeL2Entry(userId: string, sessionId: string | undefined, ts: number): void {
  getDb()
    .prepare(
      `DELETE FROM memory_l2 WHERE user_id = ? AND COALESCE(session_id, '') = COALESCE(?, '') AND ts = ?`,
    )
    .run(userId, sessionId ?? '', ts)
}
