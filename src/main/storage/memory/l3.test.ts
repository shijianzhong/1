import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// —— L3 检索单测（FTS5 中文分词 + 三路召回 + retain 拆分）——
// vitest 下 better-sqlite3 native ABI 可用（Node 环境），用内存库 + v2 schema 真实测。

let memDb: Database.Database

vi.mock('../db', () => ({
  getDb: () => memDb,
}))

// mock 后再 import 被测模块（vitest 提升 vi.mock，静态 import 顺序安全）
const { saveL3, getL3, searchL3, removeL3, listL3, tokenizeForFts } = await import('./l3')
const { splitAtomicMemories } = await import('../../tools/builtin/memory')

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE memory_l3 (
      user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, ts INTEGER NOT NULL,
      PRIMARY KEY (user_id, key)
    );
    CREATE VIRTUAL TABLE memory_l3_fts USING fts5(seg, user_id UNINDEXED, key UNINDEXED, tokenize='unicode61');
  `)
  return db
}

beforeEach(() => {
  memDb = freshDb()
})

const U = 'local'

describe('tokenizeForFts 中文预分词', () => {
  it('中文切单字 + bigram', () => {
    const seg = tokenizeForFts('跑步')
    expect(seg).toContain('跑')
    expect(seg).toContain('步')
    expect(seg).toContain('跑步')
  })
  it('英文单词作整体 token 不拆', () => {
    const seg = tokenizeForFts('喜欢 electron 框架')
    expect(seg).toContain('electron')
    expect(seg.split(' ')).not.toContain('e')
  })
  it('中英文混合', () => {
    const seg = tokenizeForFts('技术栈 electron')
    expect(seg).toContain('技术')
    expect(seg).toContain('electron')
  })
})

describe('L3 读写 + FTS 同步', () => {
  it('saveL3 写入并可 getL3 取回', () => {
    saveL3(U, 'preference_运动', '用户喜欢跑步和健身')
    expect(getL3(U, 'preference_运动')).toBe('用户喜欢跑步和健身')
  })

  it('saveL3 覆盖更新', () => {
    saveL3(U, 'k', '旧值')
    saveL3(U, 'k', '新值')
    expect(getL3(U, 'k')).toBe('新值')
  })

  it('removeL3 同步清 FTS', () => {
    saveL3(U, 'preference_运动', '用户喜欢跑步')
    removeL3(U, 'preference_运动')
    expect(getL3(U, 'preference_运动')).toBeNull()
    expect(searchL3(U, '跑步')).toHaveLength(0)
  })
})

describe('searchL3 中文语义召回（FTS 主路）', () => {
  beforeEach(() => {
    saveL3(U, 'preference_运动', '用户喜欢跑步和健身')
    saveL3(U, 'identity_职业', '用户是一名软件工程师')
    saveL3(U, 'preference_语言', '用户偏好用中文交流')
  })

  it('按 value 内容命中（2 字中文词）', () => {
    const hits = searchL3(U, '跑步')
    expect(hits.map((h) => h.key)).toContain('preference_运动')
  })

  it('按另一 2 字词命中同条', () => {
    const hits = searchL3(U, '健身')
    expect(hits.map((h) => h.key)).toContain('preference_运动')
  })

  it('key 精确命中权重最高', () => {
    const hits = searchL3(U, 'preference_运动')
    expect(hits[0]?.key).toBe('preference_运动')
  })

  it('不相关查询返回空', () => {
    expect(searchL3(U, '量子力学')).toHaveLength(0)
  })

  it('英文 token 命中', () => {
    saveL3(U, 'project_技术栈', '项目用 electron 和 react')
    const hits = searchL3(U, 'electron')
    expect(hits.map((h) => h.key)).toContain('project_技术栈')
  })

  it('limit 生效', () => {
    for (let i = 0; i < 10; i++) saveL3(U, `extra_${i}`, `共同词 测试 ${i}`)
    expect(searchL3(U, '共同词', 3).length).toBeLessThanOrEqual(3)
  })

  it('含 % 的查询按字面量匹配，不当通配符全表扫（断言 4.5 LIKE 转义）', () => {
    saveL3(U, 'fact_折扣', '折扣 50% 限时')
    saveL3(U, 'identity_职业', '用户是工程师')
    // 含 % 的查询：未转义时 % 是通配符会全表命中（两条都返回）；
    // 转义后只命中真正含「50%」字面量的那条。
    const hits = searchL3(U, '50%')
    expect(hits.map((h) => h.key)).toContain('fact_折扣')
    expect(hits.map((h) => h.key)).not.toContain('identity_职业')
  })

  it('含 _ 的查询按字面量匹配，不当单字通配符（断言 4.5 LIKE 转义）', () => {
    saveL3(U, 'project_命名', '变量名 user_name 很清晰')
    saveL3(U, 'fact_其它', '完全无关的内容 xyz')
    // 未转义时「user_name」里的 _ 是单字通配符，会命中「userXname」类串；
    // 转义后按字面下划线匹配，只命中真正含「user_name」的那条。
    const hits = searchL3(U, 'user_name')
    expect(hits.map((h) => h.key)).toContain('project_命名')
    expect(hits.map((h) => h.key)).not.toContain('fact_其它')
  })
})

describe('splitAtomicMemories 原子拆分', () => {
  it('按中文句号拆', () => {
    expect(splitAtomicMemories('用户喜欢跑步。用户也喜欢游泳')).toEqual([
      '用户喜欢跑步',
      '用户也喜欢游泳',
    ])
  })
  it('按换行拆', () => {
    expect(splitAtomicMemories('技术栈是 electron\n包管理用 pnpm')).toEqual([
      '技术栈是 electron',
      '包管理用 pnpm',
    ])
  })
  it('过滤过短碎片（<4 字）', () => {
    expect(splitAtomicMemories('好。用户喜欢跑步')).toEqual(['用户喜欢跑步'])
  })
  it('单条原文保留', () => {
    expect(splitAtomicMemories('用户是一名软件工程师')).toEqual(['用户是一名软件工程师'])
  })
})

describe('listL3 全量读取', () => {
  it('返回全部 L3 fact（含 value）', () => {
    saveL3('local', 'preference:run', 'likes running')
    saveL3('local', 'project:x', 'uses One')
    const all = listL3('local')
    expect(all).toHaveLength(2)
    expect(all.map((x) => x.key).sort()).toEqual(['preference:run', 'project:x'])
    expect(all.find((x) => x.key === 'preference:run')?.value).toBe('likes running')
  })
  it('不同 user 隔离', () => {
    saveL3('local', 'k', 'v')
    expect(listL3('other')).toHaveLength(0)
  })
})
