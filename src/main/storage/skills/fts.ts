import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from '../db'
import { getSkillsPath } from '../paths'
import { parseSkillMd } from './parser'
import { tokenizeForFts } from '../memory/l3'

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

/** 统计 skill 目录数（仅含 SKILL.md 的子目录） */
export function countSkillFiles(): number {
  const dir = getSkillsPath()
  if (!existsSync(dir)) return 0
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('skl_upload_'))
    .filter((e) => existsSync(join(dir, e.name, 'SKILL.md')))
    .length
}

export function countSkillsFtsRows(): number {
  const db = getDb()
  return (db.prepare('SELECT COUNT(*) as c FROM skills_fts').get() as { c: number }).c
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
  const pattern = `%${q}%`
  const bump = (row: SkillSearchHit, weight: number): void => {
    hit.set(row.id, row)
    score.set(row.id, (score.get(row.id) ?? 0) + weight)
  }

  const nameRows = db.prepare(
    `SELECT skill_id as id, name, description as desc
     FROM skills_fts
     WHERE name = ? OR name LIKE ?
     LIMIT ?`,
  ).all(q, `${q}%`, limit) as SkillSearchHit[]
  for (const row of nameRows) bump(row, 3)

  const tagRows = db.prepare(
    `SELECT skill_id as id, name, description as desc
     FROM skills_fts
     WHERE tags = ? OR tags LIKE ?
     LIMIT ?`,
  ).all(q, pattern, limit) as SkillSearchHit[]
  for (const row of tagRows) bump(row, 2.5)

  const match = (() => {
    const seg = tokenizeForFts(q)
    const words = seg.split(' ').filter(Boolean)
    const terms = (words.filter((w) => [...w].length >= 2).length > 0
      ? words.filter((w) => [...w].length >= 2)
      : words)
      .map((w) => `"${w.replace(/"/g, ' ')}"`)
    return terms.join(' OR ')
  })()
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

  const likeRows = db.prepare(
    `SELECT skill_id as id, name, description as desc
     FROM skills_fts
     WHERE name LIKE ? OR description LIKE ? OR tags LIKE ? OR content_raw LIKE ?
     LIMIT ?`,
  ).all(pattern, pattern, pattern, pattern, limit) as SkillSearchHit[]
  for (const row of likeRows) bump(row, 1)

  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => hit.get(id))
    .filter((row): row is SkillSearchHit => !!row)
}

/** 重建 FTS 索引：扫描 config/skills/ 下的 SKILL.md 目录 */
export function reindexSkillsFts(): void {
  const dir = getSkillsPath()
  const rows: { id: string; name: string; description?: string; tags?: string[]; content: string }[] = []
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('skl_upload_')) continue
      const skillMdPath = join(dir, entry.name, 'SKILL.md')
      if (!existsSync(skillMdPath)) continue
      try {
        const text = readFileSync(skillMdPath, 'utf8')
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
        // 单个 SKILL.md 读取失败跳过，不阻断整体重建
      }
    }
  }
  const db = getDb()
  const ins = db.prepare(
    'INSERT INTO skills_fts (skill_id, name, description, tags, content_tokenized, content_raw) VALUES (?, ?, ?, ?, ?, ?)',
  )
  db.transaction(() => {
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
  })()
}
