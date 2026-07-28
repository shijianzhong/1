import { getDb } from '../db'
import type { L3Fact } from '@shared/types'

// —— L3 长期沉淀（§三之三 D + 铁律21）——
// key-value 存 SQLite memory_l3，走 memory_recall/memory_search 工具按需检索
// （不硬塞 prompt）。

/** 写入/更新 L3 fact（按 user_id + key 唯一） */
export function saveL3(userId: string, key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO memory_l3 (user_id, key, value, ts)
       VALUES (@userId, @key, @value, @ts)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, ts = excluded.ts`,
    )
    .run({ userId, key, value, ts: Date.now() })
}

/** 取单条 L3 */
export function getL3(userId: string, key: string): string | null {
  const row = getDb()
    .prepare('SELECT value FROM memory_l3 WHERE user_id = ? AND key = ?')
    .get(userId, key) as { value: string } | undefined
  return row?.value ?? null
}

/** 列出所有 L3 key */
export function listL3Keys(userId: string): string[] {
  return (
    getDb()
      .prepare('SELECT key FROM memory_l3 WHERE user_id = ? ORDER BY ts DESC')
      .all(userId) as { key: string }[]
  ).map((r) => r.key)
}

/**
 * 检索 L3：按 query 关键词模糊匹配 key 或 value。
 * 简化实现（无向量检索）；后续可接 embedding。
 */
export function searchL3(userId: string, query: string, limit = 5): L3Fact[] {
  const pattern = `%${query}%`
  return getDb()
    .prepare(
      `SELECT user_id as userId, key, value, ts FROM memory_l3
       WHERE user_id = ? AND (key LIKE ? OR value LIKE ?)
       ORDER BY ts DESC LIMIT ?`,
    )
    .all(userId, pattern, pattern, limit) as L3Fact[]
}

/** 删除 L3 */
export function removeL3(userId: string, key: string): void {
  getDb().prepare('DELETE FROM memory_l3 WHERE user_id = ? AND key = ?').run(
    userId,
    key,
  )
}
