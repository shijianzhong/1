import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync as fsMkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { getCorruptDbPath, getDbBackupPath, getDbPath } from './paths'
import { logger } from '../logger'

// —— SQLite 连接 + WAL + schema 迁移 + 启动校验 + 损坏恢复（§11.4 + §5.2.3）——

let dbInstance: Database.Database | null = null

/** 迁移版本号（每次 schema 变更加一条 migration） */
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
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        meta TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL DEFAULT 'local',
        session_id TEXT,
        capability_id TEXT,
        status TEXT NOT NULL,
        graph TEXT,
        result TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id, created_at);

      CREATE TABLE IF NOT EXISTS memory_l1 (
        session_id TEXT PRIMARY KEY,
        summary TEXT,
        summarized_up_to TEXT,
        ts INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_l2 (
        user_id TEXT NOT NULL,
        session_id TEXT,
        digest TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_l2_user ON memory_l2(user_id, ts);

      CREATE TABLE IF NOT EXISTS memory_l3 (
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        ts INTEGER NOT NULL,
        PRIMARY KEY (user_id, key)
      );

      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );
    `,
  },
]

/** 周期备份：把当前库复制为 .bak（写操作前后调用太频，启动时调一次） */
function backupCurrentDb(): void {
  const dbPath = getDbPath()
  if (!existsSync(dbPath)) return
  try {
    copyFileSync(dbPath, getDbBackupPath())
    logger.info('[db] backed up to one.db.bak')
  } catch (error) {
    logger.warn('[db] backup failed', error)
  }
}

/**
 * 启动校验 + 损坏恢复（§11.4）。
 * 检测库损坏 → 备份当前坏库为 one.db.corrupt-<ts> → 从 .bak 恢复 → 无则重建空库。
 */
function verifyIntegrity(db: Database.Database): boolean {
  try {
    const row = db.pragma('integrity_check', { simple: true }) as
      | { integrity_check?: string }
      | string
    const ok =
      typeof row === 'string'
        ? row === 'ok'
        : (row?.integrity_check ?? '') === 'ok'
    return ok
  } catch {
    return false
  }
}

function recoverFromCorruption(): void {
  const dbPath = getDbPath()
  const corruptPath = getCorruptDbPath()
  const backupPath = getDbBackupPath()
  try {
    if (existsSync(dbPath)) {
      renameSync(dbPath, corruptPath)
      logger.error(`[db] 库损坏，已备份为 ${corruptPath}`)
    }
    if (existsSync(backupPath)) {
      copyFileSync(backupPath, dbPath)
      logger.info('[db] 从 one.db.bak 恢复')
    } else {
      logger.warn('[db] 无备份，将重建空库')
    }
  } catch (error) {
    logger.error('[db] 恢复失败', error)
  }
}

/** 应用迁移：按版本号顺序执行未应用的 migration */
function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
  `)
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_version').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  )
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue
    logger.info(`[db] applying migration v${m.version}`)
    db.exec(m.sql)
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version)
  }
}

/** 打开/创建数据库连接（主进程 app.ready 后调用） */
export function getDb(): Database.Database {
  if (dbInstance) return dbInstance

  const dbPath = getDbPath()
  // 确保 userData 目录存在
  fsMkdirSync(dirname(dbPath), { recursive: true })

  let db: Database.Database
  try {
    db = new Database(dbPath)
    if (!verifyIntegrity(db)) {
      db.close()
      recoverFromCorruption()
      db = new Database(dbPath)
      // 恢复后仍损坏则删了重建空库
      if (!verifyIntegrity(db)) {
        logger.error('[db] 恢复后仍损坏，重建空库')
        db.close()
        if (existsSync(dbPath)) renameSync(dbPath, getCorruptDbPath())
        db = new Database(dbPath)
      }
    }
  } catch (error) {
    logger.error('[db] 打开失败，重建空库', error)
    db = new Database(dbPath)
  }

  // —— WAL 模式（§11.4）：防写一半断电损坏 ——
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  runMigrations(db)
  backupCurrentDb()

  dbInstance = db
  startPeriodicBackup()
  return db
}

const BACKUP_INTERVAL_MS = 30 * 60 * 1000 // 30min 周期备份
let backupTimer: NodeJS.Timeout | null = null

/** 周期备份（§11.4：损坏恢复从 .bak 恢复） */
function startPeriodicBackup(): void {
  if (backupTimer) clearInterval(backupTimer)
  backupTimer = setInterval(() => {
    if (dbInstance) {
      try {
        const dbPath = getDbPath()
        if (existsSync(dbPath)) copyFileSync(dbPath, getDbBackupPath())
      } catch (error) {
        logger.warn('[db] 周期备份失败', error)
      }
    }
  }, BACKUP_INTERVAL_MS)
}

/** 关闭连接（app before-quit 调用） */
export function closeDb(): void {
  if (backupTimer) {
    clearInterval(backupTimer)
    backupTimer = null
  }
  if (dbInstance) {
    // 退出前再备份一次
    try {
      const dbPath = getDbPath()
      if (existsSync(dbPath)) copyFileSync(dbPath, getDbBackupPath())
    } catch (error) {
      logger.warn('[db] 退出备份失败', error)
    }
    dbInstance.close()
    dbInstance = null
  }
}

