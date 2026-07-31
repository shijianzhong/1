import { getDb } from '../db'
import type { L3Fact } from '@shared/types'

// —— L3 长期沉淀（§三之三 D + 铁律21）——
// key-value 存 SQLite memory_l3，走 memory_recall/memory_search/memory_retain 工具
// 按需检索（不硬塞 prompt）。
//
// 检索三路召回（searchL3）：
//   1. FTS5（memory_l3_fts）：中文经预分词（单字+bigram 空格连接）写入 seg 列，
//      unicode61 分词命中 + BM25 排序——解决 LIKE 对同义/词序变化无力的问题。
//   2. LIKE 子串：兜底精确片段（FTS 分词后单字过碎时的补充）。
//   3. key 精确/前缀：key 本身是结构化入口，优先命中。
// 三路结果按分合并去重，FTS 命中权重最高。

/**
 * 中文预分词：把文本切成「单字 + 相邻 bigram」用空格连接。
 * unicode61 按空格/标点分词，预处理后即可命中连续中文里的 2 字词
 * （原生 unicode61 把整段中文当一个 token、trigram 需 ≥3 字，都会漏掉「跑步」「健身」）。
 * 英文/数字串作为整体 token 保留（不拆）。
 */
export function tokenizeForFts(text: string): string {
  const s = text.toLowerCase()
  const tokens: string[] = []
  // 连续 ASCII 字母数字为一组（英文单词/数字），其余按字符处理（中日韩等）
  const re = /[a-z0-9_]+|[^\sa-z0-9_]/g
  let m: RegExpExecArray | null
  let prevCjk: string | null = null
  while ((m = re.exec(s)) !== null) {
    const tok = m[0]
    const isAsciiWord = /^[a-z0-9_]+$/.test(tok)
    if (isAsciiWord) {
      tokens.push(tok)
      prevCjk = null
      continue
    }
    // 单字（CJK 或其它单字符）
    if (/\s/.test(tok)) {
      prevCjk = null
      continue
    }
    tokens.push(tok)
    if (prevCjk) tokens.push(prevCjk + tok) // bigram
    prevCjk = tok
  }
  return tokens.join(' ')
}

/** 把查询串转成 FTS5 MATCH 表达式：bigram 用 AND 语义太严，这里用 OR 连接提高召回 */
function buildMatchQuery(query: string): string {
  const seg = tokenizeForFts(query)
  // 只取长度 ≥2 的 bigram/单词作检索词（单字太碎，单独检索意义小）；全是单字时退化为单字 OR
  const words = seg.split(' ').filter(Boolean)
  const bigrams = words.filter((w) => [...w].length >= 2)
  const terms = (bigrams.length > 0 ? bigrams : words)
    .map((w) => `"${w.replace(/"/g, ' ')}"`)
  return terms.length > 0 ? terms.join(' OR ') : ''
}

/** 写入/更新 L3 fact（按 user_id + key 唯一），并同步 FTS 索引 */
export function saveL3(userId: string, key: string, value: string): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO memory_l3 (user_id, key, value, ts)
     VALUES (@userId, @key, @value, @ts)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, ts = excluded.ts`,
  ).run({ userId, key, value, ts: Date.now() })

  // 同步 FTS：先删旧行再插新行（contentless 模式靠 rowid 对应，这里手动维护）
  db.prepare('DELETE FROM memory_l3_fts WHERE user_id = ? AND key = ?').run(userId, key)
  db.prepare('INSERT INTO memory_l3_fts (seg, user_id, key) VALUES (?, ?, ?)').run(
    tokenizeForFts(`${key} ${value}`),
    userId,
    key,
  )
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
 * 检索 L3：三路召回合并。
 * 1) key 精确/前缀命中（权重最高）2) FTS5 BM25（语义/词序）3) LIKE 子串兜底。
 * 返回按相关度排序，最多 limit 条。
 */
export function searchL3(userId: string, query: string, limit = 5): L3Fact[] {
  const db = getDb()
  const score = new Map<string, number>()
  const bump = (key: string, w: number) => score.set(key, (score.get(key) ?? 0) + w)

  // 路 1：key 精确 / 前缀
  const keyRows = db
    .prepare(
      'SELECT key FROM memory_l3 WHERE user_id = ? AND (key = ? OR key LIKE ?) LIMIT ?',
    )
    .all(userId, query, `${query}%`, limit) as { key: string }[]
  for (const r of keyRows) bump(r.key, 3)

  // 路 2：FTS5（BM25，rank 越小越相关）
  const match = buildMatchQuery(query)
  if (match) {
    try {
      const ftsRows = db
        .prepare(
          `SELECT key, rank FROM memory_l3_fts WHERE memory_l3_fts MATCH ? AND user_id = ?
           ORDER BY rank LIMIT ?`,
        )
        .all(match, userId, limit) as { key: string; rank: number }[]
      // rank 是负数（越负越相关），转成 0~2 的正权重
      ftsRows.forEach((r, i) => bump(r.key, 2 - i * (1 / Math.max(1, ftsRows.length))))
    } catch {
      // FTS 查询语法异常（极端字符）→ 跳过该路，不阻断其它召回
    }
  }

  // 路 3：LIKE 子串兜底
  const pattern = `%${query}%`
  const likeRows = db
    .prepare(
      'SELECT key FROM memory_l3 WHERE user_id = ? AND (key LIKE ? OR value LIKE ?) LIMIT ?',
    )
    .all(userId, pattern, pattern, limit) as { key: string }[]
  for (const r of likeRows) bump(r.key, 1)

  if (score.size === 0) return []

  // 按分排序取 top，再回表取 value
  const topKeys = [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k]) => k)
  const placeholders = topKeys.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT user_id as userId, key, value, ts FROM memory_l3
       WHERE user_id = ? AND key IN (${placeholders})`,
    )
    .all(userId, ...topKeys) as L3Fact[]
  const byKey = new Map(rows.map((r) => [r.key, r]))
  return topKeys.map((k) => byKey.get(k)).filter((r): r is L3Fact => !!r)
}

/** 删除 L3（同步清 FTS） */
export function removeL3(userId: string, key: string): void {
  const db = getDb()
  db.prepare('DELETE FROM memory_l3 WHERE user_id = ? AND key = ?').run(userId, key)
  db.prepare('DELETE FROM memory_l3_fts WHERE user_id = ? AND key = ?').run(userId, key)
}

/** 一次性回填：把存量 memory_l3 全部重建进 FTS（迁移后调用幂等） */
export function reindexL3Fts(): void {
  const db = getDb()
  db.prepare('DELETE FROM memory_l3_fts').run()
  const rows = db.prepare('SELECT user_id as userId, key, value FROM memory_l3').all() as {
    userId: string
    key: string
    value: string
  }[]
  const ins = db.prepare('INSERT INTO memory_l3_fts (seg, user_id, key) VALUES (?, ?, ?)')
  for (const r of rows) ins.run(tokenizeForFts(`${r.key} ${r.value}`), r.userId, r.key)
}
