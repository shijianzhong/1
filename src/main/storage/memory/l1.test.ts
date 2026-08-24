import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// —— L1 存储单测（listL1 / removeL1）——
// vitest 下 better-sqlite3 native ABI 可用（Node 环境），用内存库 + 真实 schema 测。

let memDb: Database.Database

vi.mock('../db', () => ({
  getDb: () => memDb,
}))

const { saveL1, listL1, removeL1 } = await import('./l1')

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE memory_l1 (
      session_id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      summarized_up_to TEXT,
      ts INTEGER NOT NULL
    );
  `)
  return db
}

beforeEach(() => {
  memDb = freshDb()
})

describe('L1 存储', () => {
  it('saveL1 后 listL1 按 ts 倒序返回', () => {
    saveL1({ sessionId: 's1', summary: 'a', ts: 100 })
    saveL1({ sessionId: 's2', summary: 'b', ts: 200 })
    expect(listL1().map((x) => x.sessionId)).toEqual(['s2', 's1'])
  })

  it('removeL1 删除指定会话', () => {
    saveL1({ sessionId: 's1', summary: 'a', ts: 100 })
    removeL1('s1')
    expect(listL1()).toHaveLength(0)
  })

  it('saveL1 同 session 覆盖（不新增行）', () => {
    saveL1({ sessionId: 's1', summary: 'a', ts: 100 })
    saveL1({ sessionId: 's1', summary: 'a2', ts: 150 })
    const all = listL1()
    expect(all).toHaveLength(1)
    expect(all[0].summary).toBe('a2')
  })

  it('listL1 映射 summarizedUpTo 为可选字段', () => {
    saveL1({ sessionId: 's1', summary: 'a', summarizedUpTo: '5', ts: 100 })
    expect(listL1()[0].summarizedUpTo).toBe('5')
  })
})
