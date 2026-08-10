import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

// 复刻 MIGRATIONS 的 v1/v2/v3，独立 in-memory 库验证幂等
const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL DEFAULT 'local',
        title TEXT NOT NULL,
        capability_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        meta TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_l3_fts USING fts5(seg, user_id UNINDEXED, key UNINDEXED, tokenize='unicode61');
    `,
  },
  {
    version: 3,
    sql: 'ALTER TABLE sessions ADD COLUMN cwd TEXT',
  },
]

function runMigrations(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);')
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_version').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  )
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue
    db.exec(m.sql)
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version)
  }
}

describe('db migration v3', () => {
  it('新库执行 v3 后 sessions 含 cwd 列', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const cols = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
    expect(cols.map((c) => c.name)).toContain('cwd')
    db.close()
  })

  it('已有 v2 库增量执行 v3 成功（幂等）', () => {
    const db = new Database(':memory:')
    // 先只跑 v1+v2，模拟存量库
    for (const m of MIGRATIONS.slice(0, 2)) {
      db.exec(m.sql)
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version)
    }
    // 再跑全量迁移（v3 应被执行一次）
    runMigrations(db)
    const versions = db.prepare('SELECT version FROM schema_version').all() as { version: number }[]
    expect(versions.map((v) => v.version)).toContain(3)
    const cols = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
    expect(cols.map((c) => c.name)).toContain('cwd')
    db.close()
  })

  it('cwd 可写入并可读回', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const id = 'test-session'
    db.prepare(
      'INSERT INTO sessions (id, user_id, title, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, 'local', 't', '/Users/test/proj', Date.now(), Date.now())
    const row = db.prepare('SELECT cwd FROM sessions WHERE id = ?').get(id) as { cwd: string | null }
    expect(row.cwd).toBe('/Users/test/proj')
    db.close()
  })
})
