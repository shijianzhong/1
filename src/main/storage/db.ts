import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync as fsMkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { getCorruptDbPath, getDbBackupPath, getDbPath } from './paths'
import { logger } from '../logger'
// 循环导入安全：reindexL3Fts 仅在 getDb() 函数体内调用（非模块顶层），此时 l3.ts 已完成初始化
import { reindexL3Fts } from './memory/l3'
import { countSkillFiles, countSkillsFtsRows, reindexSkillsFts } from './skills/fts'

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
  {
    // v2：L3 全文检索（FTS5）。中文经预分词（单字+bigram 空格连接）写入 seg 列，
    // unicode61 即可命中（原生 trigram 对 2 字中文失效、unicode61 对连续中文不分词）。
    version: 2,
    sql: `
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_l3_fts USING fts5(
        seg,
        user_id UNINDEXED,
        key UNINDEXED,
        tokenize='unicode61'
      );
    `,
  },
  {
    // v3：sessions 加 cwd 列（项目根概念，agent 文件工具 + shell 默认 cwd 用）
    version: 3,
    sql: 'ALTER TABLE sessions ADD COLUMN cwd TEXT',
  },
  {
    // v4：skills 全文检索（主数据在目录化 SKILL.md，SQLite 只存 FTS 索引）
    version: 4,
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
    // v5：skills_fts 增加 tags 列。FTS5 不能 ALTER，直接重建后由启动自检回填。
    version: 5,
    sql: `
      DROP TABLE IF EXISTS skills_fts;
      CREATE VIRTUAL TABLE skills_fts USING fts5(
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

  // L3 FTS 索引一致性自检：行数不一致（如 v2 迁移前存量未回填）则重建一次（幂等）
  try {
    const l3Count = (db.prepare('SELECT COUNT(*) as c FROM memory_l3').get() as { c: number }).c
    const ftsCount = (db.prepare('SELECT COUNT(*) as c FROM memory_l3_fts').get() as { c: number }).c
    if (l3Count !== ftsCount) {
      reindexL3Fts()
      logger.info(`[db] L3 FTS 索引重建（l3=${l3Count} fts=${ftsCount}）`)
    }
  } catch (error) {
    logger.warn('[db] L3 FTS 自检失败（非致命）', error)
  }

  try {
    const skillFiles = countSkillFiles()
    const skillFts = countSkillsFtsRows()
    if (skillFiles !== skillFts) {
      reindexSkillsFts()
      logger.info(`[db] Skill FTS 索引重建（files=${skillFiles} fts=${skillFts}）`)
    }
  } catch (error) {
    logger.warn('[db] Skill FTS 自检失败（非致命）', error)
  }

  startPeriodicBackup()
  return db
}

const BACKUP_INTERVAL_MS = 30 * 60 * 1000 // 30min 周期备份
let backupTimer: NodeJS.Timeout | null = null

/**
 * 完整快照备份（§11.4：损坏恢复从 .bak 恢复）。
 * WAL 模式下已提交数据可能还在 db-wal 里未 checkpoint——只拷主库文件会得到
 * 缺最近写入的「假备份」，恢复时丢数据。先 TRUNCATE checkpoint 把 WAL 合并回
 * 主库再拷贝，才是完整快照（单进程单连接，无 BUSY 风险；30min 一次同步阻塞可接受）。
 */
function backupDatabase(): void {
  if (!dbInstance) return
  const dbPath = getDbPath()
  if (!existsSync(dbPath)) return
  dbInstance.pragma('wal_checkpoint(TRUNCATE)')
  copyFileSync(dbPath, getDbBackupPath())
}

/** 周期备份 */
function startPeriodicBackup(): void {
  if (backupTimer) clearInterval(backupTimer)
  backupTimer = setInterval(() => {
    try {
      backupDatabase()
    } catch (error) {
      logger.warn('[db] 周期备份失败', error)
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
      backupDatabase()
    } catch (error) {
      logger.warn('[db] 退出备份失败', error)
    }
    dbInstance.close()
    dbInstance = null
  }
}
