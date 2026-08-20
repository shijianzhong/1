import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from '../db'
import { getSkillsPath } from '../paths'
import { parseSkillMd } from './parser'
import { buildMatchQuery, escapeLikePattern, tokenizeForFts } from '../memory/l3'

export interface SkillSearchHit {
  id: string
  name: string
  desc?: string
}

function normalizeText(value?: string): string {
  return value?.trim() ?? ''
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function fallbackDescription(content: string): string {
  const text = collapseWhitespace(content.replace(/[#>*`_[\]\-]/g, ' '))
  return text.slice(0, 120)
}

function descriptionOf(input: { description?: string; content: string }): string {
  const desc = normalizeText(input.description)
  return desc || fallbackDescription(input.content)
}

function normalizeTags(tags?: string[]): string[] {
  return (tags ?? []).map((tag) => collapseWhitespace(tag)).filter(Boolean)
}

function ensureAppMetaTable(): void {
  getDb().exec('CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
}

export interface SkillsIndexData {
  count: number
  signature: string
  rows: Array<{ id: string; name: string; description?: string; tags?: string[]; content: string }>
}

export function collectSkillsIndexData(): SkillsIndexData {
  const dir = getSkillsPath()
  const hash = createHash('sha1')
  const rows: Array<{ id: string; name: string; description?: string; tags?: string[]; content: string }> = []
  let count = 0

  if (!existsSync(dir)) {
    return { count: 0, signature: hash.digest('hex'), rows }
  }

  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('skl_upload_'))
    .sort((a, b) => a.name.localeCompare(b.name))

  for (const entry of entries) {
    const skillMdPath = join(dir, entry.name, 'SKILL.md')
    if (!existsSync(skillMdPath)) continue
    count++

    try {
      const text = readFileSync(skillMdPath, 'utf8')
      hash.update(entry.name)
      hash.update('\0')
      hash.update(text)
      hash.update('\0')

      const parsed = parseSkillMd(text)
      if (!parsed) continue
      rows.push({
        id: entry.name,
        name: parsed.name,
        description: parsed.description,
        tags: parsed.tags,
        content: parsed.content,
      })
    } catch {
      hash.update(entry.name)
      hash.update('\0<read-error>\0')
    }
  }

  return { count, signature: hash.digest('hex'), rows }
}

/** 统计 skill 目录数（仅含 SKILL.md 的子目录） */
export function countSkillFiles(): number {
  return collectSkillsIndexData().count
}

export function countSkillsFtsRows(): number {
  const db = getDb()
  return (db.prepare('SELECT COUNT(*) as c FROM skills_fts').get() as { c: number }).c
}

export function getCurrentSkillsFtsSignature(): string {
  return collectSkillsIndexData().signature
}

export function getStoredSkillsFtsSignature(): string | null {
  ensureAppMetaTable()
  const row = getDb()
    .prepare('SELECT value FROM app_meta WHERE key = ?')
    .get('skills_fts_signature') as { value: string } | undefined
  return row?.value ?? null
}

function setStoredSkillsFtsSignature(signature: string): void {
  ensureAppMetaTable()
  getDb()
    .prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)')
    .run('skills_fts_signature', signature)
}

export function upsertSkillFts(input: {
  id: string
  name: string
  description?: string
  tags?: string[]
  content: string
}): void {
  const db = getDb()
  const desc = descriptionOf(input)
  const tags = normalizeTags(input.tags)
  const tagsText = tags.join(' ')
  db.transaction(() => {
    db.prepare('DELETE FROM skills_fts WHERE skill_id = ?').run(input.id)
    db.prepare(
      'INSERT INTO skills_fts (skill_id, name, description, tags, content_tokenized, content_raw) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      input.id,
      input.name,
      desc,
      tagsText,
      tokenizeForFts(`${input.name} ${tagsText} ${desc} ${input.content}`),
      `${tagsText}\n\n${input.content}`.trim(),
    )
  })()
}

export function deleteSkillFts(skillId: string): void {
  getDb().prepare('DELETE FROM skills_fts WHERE skill_id = ?').run(skillId)
}

export function searchSkills(keywords: string, limit = 8): SkillSearchHit[] {
  const q = collapseWhitespace(keywords)
  if (!q) return []
  const db = getDb()
  const score = new Map<string, number>()
  const hit = new Map<string, SkillSearchHit>()
  // 修 latent 通配符注入 bug：原 '%${q}%' 未转义，含 %/的 query（如「折扣 50%」）
  // 被当通配符 → 全表扫描拖慢主进程 + 召回噪声。escapeLikePattern 复用 l3.ts
  // （L3/kb-fts 已修，单一真相源）。ESCAPE 子句声明反斜杠为转义符。
  const escapedQ = escapeLikePattern(q)
  const pattern = `%${escapedQ}%`
  const bump = (row: SkillSearchHit, weight: number): void => {
    hit.set(row.id, row)
    score.set(row.id, (score.get(row.id) ?? 0) + weight)
  }

  // name 通道：整条 query 精确/前缀命中（原语义，3.0）。
  // 评测证：token 子串通道在 66-skill 真实池过度加权 CJK 名「纪律」类 skill 压过真目标
  // （真目标常 ASCII 名如 tech-research，与 CJK query 零 token 共享）→ 回归 Primary Top1，
  // 故保留原整条精确/前缀，不开 token 子串（见 docs/SKILL_RAG_EVAL.md 重调结论）。
  const nameRows = db.prepare(
    `SELECT skill_id as id, name, description as desc
     FROM skills_fts
     WHERE name = ? OR name LIKE ? ESCAPE '\\'
     LIMIT ?`,
  ).all(q, `${escapedQ}%`, limit) as SkillSearchHit[]
  for (const row of nameRows) bump(row, 3)

  const tagRows = db.prepare(
    `SELECT skill_id as id, name, description as desc
     FROM skills_fts
     WHERE tags = ? OR tags LIKE ? ESCAPE '\\'
     LIMIT ?`,
  ).all(q, pattern, limit) as SkillSearchHit[]
  for (const row of tagRows) bump(row, 2.5)

  // FTS5 通道：MATCH + ORDER BY rank（等列权 bm25）。
  // 评测证：bm25 列加权（name=10…）在真实池同样过度加权 CJK 名 → 回归 Top1，故保留原 rank。
  // buildMatchQuery 复用 l3.ts（DRY 单一真相源，与 L3/kb-fts 同构）。
  const match = buildMatchQuery(q)
  if (match) {
    try {
      const rows = db.prepare(
        `SELECT skill_id as id, name, description as desc, rank
         FROM skills_fts
         WHERE skills_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      ).all(match, limit) as Array<SkillSearchHit & { rank: number }>
      rows.forEach((row, index) => bump(row, 2 - index * (1 / Math.max(1, rows.length))))
    } catch {
      // 极端查询字符导致 MATCH 语法问题时降级到其它召回路
    }
  }

  // LIKE 兜底通道：转义后的 pattern（latent bug 修同上）。
  const likeRows = db.prepare(
    `SELECT skill_id as id, name, description as desc
     FROM skills_fts
     WHERE name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\'
        OR tags LIKE ? ESCAPE '\\' OR content_raw LIKE ? ESCAPE '\\'
     LIMIT ?`,
  ).all(pattern, pattern, pattern, pattern, limit) as SkillSearchHit[]
  for (const row of likeRows) bump(row, 1)

  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => hit.get(id))
    .filter((row): row is SkillSearchHit => !!row)
}

/** 重建 FTS 索引：扫描 config/skills/ 下的 SKILL.md 目录。可传入预计算数据避免重复 I/O */
export function reindexSkillsFts(precomputed?: SkillsIndexData): void {
  const { rows, signature } = precomputed ?? collectSkillsIndexData()
  const db = getDb()
  const ins = db.prepare(
    'INSERT INTO skills_fts (skill_id, name, description, tags, content_tokenized, content_raw) VALUES (?, ?, ?, ?, ?, ?)',
  )
  db.transaction(() => {
    ensureAppMetaTable()
    db.prepare('DELETE FROM skills_fts').run()
    for (const row of rows) {
      const desc = descriptionOf(row)
      const tags = normalizeTags(row.tags)
      const tagsText = tags.join(' ')
      ins.run(
        row.id,
        row.name,
        desc,
        tagsText,
        tokenizeForFts(`${row.name} ${tagsText} ${desc} ${row.content}`),
        `${tagsText}\n\n${row.content}`.trim(),
      )
    }
    setStoredSkillsFtsSignature(signature)
  })()
}
