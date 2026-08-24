import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// —— L2 存储单测（listL2 / updateL2Digest / removeL2Entry / removeL2）——
// vitest 下 better-sqlite3 native ABI 可用（Node 环境），用内存库 + 真实 schema 测。

let memDb: Database.Database

vi.mock('../db', () => ({
  getDb: () => memDb,
}))

const { listL2, saveL2, updateL2Digest, removeL2Entry, removeL2 } = await import('./l2')

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE memory_l2 (
      user_id TEXT NOT NULL,
      session_id TEXT,
      digest TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
  `)
  return db
}

beforeEach(() => {
  memDb = freshDb()
})

describe('L2 存储', () => {
  it('saveL2 + listL2 返回倒序（默认最近 10 条）', () => {
    saveL2({ userId: 'local', sessionId: 's1', digest: 'd1', ts: 100 })
    saveL2({ userId: 'local', sessionId: 's2', digest: 'd2', ts: 200 })
    expect(listL2('local').map((x) => x.digest)).toEqual(['d2', 'd1'])
  })

  it('updateL2Digest 改指定条目的 digest', () => {
    saveL2({ userId: 'local', sessionId: 's1', digest: 'd1', ts: 100 })
    updateL2Digest('local', 's1', 100, 'edited')
    expect(listL2('local')[0].digest).toBe('edited')
  })

  it('removeL2Entry 按 user+session+ts 删单条', () => {
    saveL2({ userId: 'local', sessionId: 's1', digest: 'd1', ts: 100 })
    saveL2({ userId: 'local', sessionId: 's2', digest: 'd2', ts: 200 })
    removeL2Entry('local', 's1', 100)
    const list = listL2('local')
    expect(list).toHaveLength(1)
    expect(list[0].sessionId).toBe('s2')
  })

  it('sessionId 缺失（null）也能定位更新（COALESCE 双端归一）', () => {
    saveL2({ userId: 'local', digest: 'd0', ts: 50 })
    updateL2Digest('local', undefined, 50, 'null-edited')
    expect(listL2('local')[0].digest).toBe('null-edited')
  })

  it('removeL2 删该用户全部', () => {
    saveL2({ userId: 'local', digest: 'd1', ts: 100 })
    saveL2({ userId: 'other', digest: 'd2', ts: 200 })
    removeL2('local')
    expect(listL2('local')).toHaveLength(0)
    expect(listL2('other')).toHaveLength(1)
  })
})
