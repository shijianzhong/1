import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let memDb: Database.Database

vi.mock('../db', () => ({
  getDb: () => memDb,
}))

const {
  upsertSkillFts,
  deleteSkillFts,
  searchSkills,
} = await import('./fts')

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE VIRTUAL TABLE skills_fts USING fts5(
      skill_id UNINDEXED,
      name,
      description,
      content_tokenized,
      content_raw UNINDEXED,
      tokenize='unicode61'
    );
  `)
  return db
}

beforeEach(() => {
  memDb = freshDb()
})

describe('storage/skills/fts', () => {
  it('按名称精确/前缀召回', () => {
    upsertSkillFts({
      id: 's1',
      name: '品牌文案规范',
      description: '品牌写作约束',
      content: '标题、标语、品牌语气要求',
    })
    const hits = searchSkills('品牌文案', 5)
    expect(hits[0]?.id).toBe('s1')
  })

  it('按正文语义词召回', () => {
    upsertSkillFts({
      id: 's1',
      name: '数据分析技能',
      description: '分析表格与 CSV',
      content: '适合做透视表、统计汇总和数据清洗',
    })
    const hits = searchSkills('透视表', 5)
    expect(hits.map((h) => h.id)).toContain('s1')
  })

  it('description 为空时用 content 片段作为 desc', () => {
    upsertSkillFts({
      id: 's1',
      name: '调研技能',
      content: '这个技能用于行业调研、竞品分析与资料收集',
    })
    const hits = searchSkills('行业调研', 5)
    expect(hits[0]?.desc).toContain('行业调研')
  })

  it('删除后不再可检索', () => {
    upsertSkillFts({
      id: 's1',
      name: '设计评审',
      description: '评审视觉稿',
      content: '用于视觉和交互评审',
    })
    deleteSkillFts('s1')
    expect(searchSkills('设计评审', 5)).toEqual([])
  })

  it('多字中文 content LIKE 兜底（content_raw 存原始未分词文本）', () => {
    // content_tokenized 中中文被拆为单字+bigram（空格分隔），
    // LIKE '%数据分析%' 无法在 tokenized 列命中（字符间有空格）；
    // content_raw 存原始文本，LIKE 可直接子串匹配。
    upsertSkillFts({
      id: 's1',
      name: '通用助手',
      description: '杂项工具',
      content: '本技能覆盖数据分析与可视化展示的完整流程',
    })

    // 行为层：searchSkills 能通过多字中文找到只出现在 content 中的 skill
    const hits = searchSkills('数据分析', 5)
    expect(hits.map((h) => h.id)).toContain('s1')

    // 直接验证列级行为：content_raw LIKE 命中，content_tokenized LIKE 不命中
    const rawHit = memDb
      .prepare('SELECT skill_id FROM skills_fts WHERE content_raw LIKE ?')
      .get('%数据分析%') as { skill_id: string } | undefined
    expect(rawHit?.skill_id).toBe('s1')

    const tokenizedMiss = memDb
      .prepare('SELECT skill_id FROM skills_fts WHERE content_tokenized LIKE ?')
      .get('%数据分析%') as { skill_id: string } | undefined
    expect(tokenizedMiss).toBeUndefined()
  })
})
