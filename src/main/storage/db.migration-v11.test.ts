import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { runMigrations } from './db'

// —— v11 迁移幂等（review #16）——
// SQLite 的 ALTER TABLE ... ADD COLUMN 无 IF NOT EXISTS。漂移库
// （dev 分支残留/手工改动/schema_version 丢失）下裸跑 v11 会
// 「duplicate column name」且每次启动重跑死循环。
// 修复：v11 声明 isApplied（PRAGMA table_info 判列存在），显式跳过登记，
// 不把异常当控制流。与 db.migration-v3/v5/v6.test 的自包含副本不同，
// 本文件直测 db.ts 的真实 runMigrations + 真实 MIGRATIONS 链。

/** 漂移库：kb_docs 已带 content 列（如手工 ALTER 过），但 schema_version 无 v11 */
function driftedDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE kb_docs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_path TEXT,
      source_kind TEXT,
      chunks INTEGER NOT NULL DEFAULT 0,
      embedding_provider TEXT,
      content TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
  `)
  return db
}

describe('db migration v11 — ALTER ADD COLUMN 幂等（review #16）', () => {
  it('content 列已存在但版本未登记 → isApplied 跳过执行，登记 v11 不抛错', () => {
    const db = driftedDb()

    expect(() => runMigrations(db)).not.toThrow()

    const versions = (
      db.prepare('SELECT version FROM schema_version ORDER BY version').all() as Array<{ version: number }>
    ).map((v) => v.version)
    expect(versions).toContain(11)
    // 重复跑第二次也幂等（applied 命中直接跳过）
    expect(() => runMigrations(db)).not.toThrow()
    db.close()
  })

  it('content 列不存在 → 正常执行 ALTER，列落库 + 版本登记', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE kb_docs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source_path TEXT,
        source_kind TEXT,
        chunks INTEGER NOT NULL DEFAULT 0,
        embedding_provider TEXT,
        created_at INTEGER,
        updated_at INTEGER
      );
    `)

    runMigrations(db)

    const cols = (db.prepare('PRAGMA table_info(kb_docs)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    )
    expect(cols).toContain('content')
    const versions = (
      db.prepare('SELECT version FROM schema_version ORDER BY version').all() as Array<{ version: number }>
    ).map((v) => v.version)
    expect(versions).toContain(11)
    // 再跑不再 ALTER（applied 短路）
    expect(() => runMigrations(db)).not.toThrow()
    db.close()
  })
})
