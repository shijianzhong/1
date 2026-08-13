import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
    `,
  },
  {
    version: 5,
    sql: `
      CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
        skill_id UNINDEXED,
        name,
        description,
        tags,
        content_tokenized,
        content_raw UNINDEXED,
        tokenize='unicode61'
      );
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
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

describe('db migration v6', () => {
  it('存量 v5 库升级后包含 app_meta 表', () => {
    const db = new Database(':memory:')
    for (const m of MIGRATIONS.slice(0, 2)) {
      db.exec(m.sql)
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version)
    }

    runMigrations(db)

    const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all() as Array<{ version: number }>
    expect(versions.map((v) => v.version)).toContain(6)

    const cols = db.prepare('PRAGMA table_info(app_meta)').all() as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toEqual(['key', 'value'])
    db.close()
  })
})
