import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync as fsMkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { getCorruptDbPath, getDbBackupPath, getDbPath } from './paths'
import { logger } from '../logger'
// 循环导入安全：reindexL3Fts 仅在 getDb() 函数体内调用（非模块顶层），此时 l3.ts 已完成初始化
import { reindexL3Fts } from './memory/l3'
import {
  collectSkillsIndexData,
  countSkillsFtsRows,
  getStoredSkillsFtsSignature,
  reindexSkillsFts,
} from './skills/fts'
// 同上：reindexKbFts 仅在 getDb() 函数体内调用，vector/kb-fts 此时已完成初始化
import { countKbChunks, countKbFtsRows, reindexKbFts } from '../vector/kb-fts'

// —— SQLite 连接 + WAL + schema 迁移 + 启动校验 + 损坏恢复（§11.4 + §5.2.3）——

let dbInstance: Database.Database | null = null

/** 读 app_meta（v6 表，通用 key-value）；KB reindex 标志 / 远程维度缓存等共用 */
export function getAppMeta(key: string): string | null {
  if (!dbInstance) return null
  const row = dbInstance
    .prepare('SELECT value FROM app_meta WHERE key = ?')
    .get(key) as { value: string } | undefined
  return row?.value ?? null
}

/** 写 app_meta（v6 表，通用 key-value）；KB vec_dim 漂移标志 / skills 签名等共用 */
export function setAppMeta(key: string, value: string): void {
  if (!dbInstance) return
  dbInstance
    .prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)')
    .run(key, value)
}

/** 迁移版本号（每次 schema 变更加一条 migration） */
const MIGRATIONS: Array<{
  version: number
  sql: string
  /**
   * 幂等前置检查：返回 true 则跳过执行、直接登记版本。
   * SQLite 的 ALTER TABLE ... ADD COLUMN 无 IF NOT EXISTS——列已存在
   * （dev 库残留/手工改动/schema_version 丢失）时裸跑会报「duplicate column name」，
   * 每次启动重跑失败死循环。此类 migration 必须用 PRAGMA table_info 显式判定，
   * 不靠捕获错误当控制流。
   */
  isApplied?: (db: Database.Database) => boolean
}> = [
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
  {
    // v6：通用元数据表（当前用于记录 skills_fts 内容签名，修复"数量不变但内容变了"漏重建）。
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    // v7：选题库（内容生产 §2.3）——调研产出选题经三维过筛后入库，状态流转驱动生产。
    version: 7,
    sql: `
      CREATE TABLE IF NOT EXISTS topics (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL DEFAULT 'local',
        title TEXT NOT NULL,
        direction TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        recommendation INTEGER,
        meta TEXT,
        tags TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_topics_user ON topics(user_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_topics_status ON topics(status);
      CREATE INDEX IF NOT EXISTS idx_topics_direction ON topics(direction);
    `,
  },
  {
    // v8：Review 档案（内容生产 §2.3）——A6 reviewer 产出 review 落库，累积质量档案迭代风格画像。
    version: 8,
    sql: `
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL DEFAULT 'local',
        asset_type TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        score REAL NOT NULL,
        verdict TEXT NOT NULL,
        notes TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reviews_asset ON reviews(asset_type, asset_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_reviews_score ON reviews(score);
    `,
  },
  {
    // v9：运行时事实流（docs/DEEPSEEK_HARNESS_LEARNING_PLAN.md P0）——
    // runs：一次 home.chat / orchestrate.run = 一个 run（与 session 非 1:1，同会话可多 run）。
    //   entry=入口（home/editor），route=路由决策回填（direct/team/directAgent/focusCap）。
    // run_events：run 内按 seq 单调追加的事实事件（路由决策/节点生命周期/工具/HITL/skill 注入）。
    //   故意不加外键：观测层与业务松耦合——runs 行创建失败时事件仍可落库（孤儿可诊断），
    //   删会话不级联清事件（诊断数据独立生命周期，清理策略后续单独定）。
    version: 9,
    sql: `
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        entry TEXT NOT NULL,
        route TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);

      CREATE TABLE IF NOT EXISTS run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        session_id TEXT,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_run_events_run_seq ON run_events(run_id, seq);
      CREATE INDEX IF NOT EXISTS idx_run_events_session ON run_events(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_run_events_type ON run_events(run_id, type);
    `,
  },
  {
    // v10：向量化知识库（docs/VECTOR_KB_PLAN.md §四）——文档分块 + 向量 + 词法 FTS。
    //   kb_chunks：分块主表，vec BLOB 可 NULL（模型未就绪/离线时新块照常落库只走词法，
    //              模型就绪后 kb:reindex 补齐向量——配合 §二降级链，功能永不因模型下不来瘫痪）。
    //              vec_dim 记维度，换 provider/模型维度变时启动自检拦漂移 → 强制 reindex。
    //              UNIQUE(doc_id, chunk_idx) 防同文档重摄取重复块。
    //   kb_chunks_fts：词法预过滤（hybrid 用），双列对齐 skills_fts（content_tokenized 喂 MATCH +
    //              content_raw UNINDEXED 给 LIKE 兜底），tokenizeForFts 中文单字+bigram 预分词。
    //   kb_docs：文档元信息，embedding_provider 记录用哪个 provider 产向量（dirty 重嵌用）。
    version: 10,
    sql: `
      CREATE TABLE IF NOT EXISTS kb_chunks (
        id          TEXT PRIMARY KEY,
        kb_id       TEXT NOT NULL,
        doc_id      TEXT NOT NULL,
        chunk_idx   INTEGER NOT NULL,
        content     TEXT NOT NULL,
        vec         BLOB,
        vec_dim     INTEGER,
        meta        TEXT,
        created_at  INTEGER NOT NULL,
        UNIQUE(doc_id, chunk_idx)
      );
      CREATE INDEX IF NOT EXISTS idx_kb_chunks_kb ON kb_chunks(kb_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
        chunk_id UNINDEXED,
        content_tokenized,
        content_raw UNINDEXED,
        doc_id UNINDEXED,
        tokenize='unicode61'
      );

      CREATE TABLE IF NOT EXISTS kb_docs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source_path TEXT,
        source_kind TEXT,
        chunks INTEGER NOT NULL DEFAULT 0,
        embedding_provider TEXT,
        created_at INTEGER,
        updated_at INTEGER
      );
    `,
  },
  {
    // v11：kb_docs 加原文存档列（docs/VECTOR_KB_PLAN.md §四/P1）。
    //   content TEXT 存完整原文——kb_chunks.content 是分块后片段，拿不回原文；
    //   换分块策略（maxTokens/overlap 改）或换模型重切时，无需重新上传即可 reindex。
    //   SQLite 单列 ALTER TABLE 无 IF NOT EXISTS：isApplied 显式判列存在（幂等）。
    version: 11,
    sql: `ALTER TABLE kb_docs ADD COLUMN content TEXT;`,
    isApplied: (db) =>
      db
        .prepare(`SELECT 1 FROM pragma_table_info('kb_docs') WHERE name = 'content'`)
        .get() !== undefined,
  },
]

/**
 * 启动备份：把当前库复制为 .bak（启动时调一次）。
 * 与周期 backupDatabase 同语义：WAL 模式下刚跑完 migration 的写入可能还在 db-wal 里
 * 未 checkpoint —— 只拷主库文件会得到缺最近建表/改表的「假备份」，损坏恢复时丢数据。
 * 故先 wal_checkpoint(TRUNCATE) 合并回主库再拷贝（单连接，无 BUSY）。
 * 入参 db 为当前打开的连接（启动时 dbInstance 尚未赋值，故显式传入）。
 */
function backupCurrentDb(db: Database.Database): void {
  const dbPath = getDbPath()
  if (!existsSync(dbPath)) return
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
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

/** 应用迁移：按版本号顺序执行未应用的 migration（export 仅供 db.migration-*.test 直测） */
export function runMigrations(db: Database.Database): void {
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
    // 幂等前置检查：目标状态已达成（如 ADD COLUMN 的列已存在）→ 登记版本跳过，
    // 不进执行路径（review #16：不把「duplicate column name」异常当控制流）
    if (m.isApplied?.(db)) {
      logger.info(`[db] migration v${m.version} 已处于目标状态，登记跳过`)
      db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(m.version)
      continue
    }
    logger.info(`[db] applying migration v${m.version}`)
    // DDL 执行 + 版本登记必须原子：中途崩溃（进程被杀/断电）会留下「表已建一半但
    // schema_version 未登记」的半截 schema → 下次启动该版本被判为未应用、重跑 CREATE
    // 可能因已存在对象报错，且部分表结构不可用。better-sqlite3 的 transaction 对 DDL
    // 亦生效（单连接串行），保证全成或全废。
    try {
      db.transaction(() => {
        db.exec(m.sql)
        db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version)
      })()
    } catch (e) {
      // 兜底防御：migration 未声明 isApplied 但库已被外部改动（如手工建列）。
      // 「duplicate column name」= 目标状态已达成，登记跳过防启动死循环；
      // 其余错误照常抛（不掩盖真问题）
      if (e instanceof Error && /duplicate column name/i.test(e.message)) {
        logger.warn(`[db] migration v${m.version} 列已存在（未声明 isApplied），登记跳过`)
        db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(m.version)
      } else {
        throw e
      }
    }
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
  backupCurrentDb(db)

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
    const data = collectSkillsIndexData()
    const skillFts = countSkillsFtsRows()
    const storedSignature = getStoredSkillsFtsSignature()
    if (data.count !== skillFts || data.signature !== storedSignature) {
      reindexSkillsFts(data)
      logger.info(
        `[db] Skill FTS 索引重建（files=${data.count} fts=${skillFts} sigMatch=${data.signature === storedSignature}）`,
      )
    }
  } catch (error) {
    logger.warn('[db] Skill FTS 自检失败（非致命）', error)
  }

  // KB FTS 索引一致性自检（镜像 L3/Skill FTS 自检）：行数不一致则重建一次（幂等）
  try {
    const chunkCount = countKbChunks()
    const kbFts = countKbFtsRows()
    if (chunkCount !== kbFts) {
      reindexKbFts()
      logger.info(`[db] KB FTS 索引重建（chunks=${chunkCount} fts=${kbFts}）`)
    }
  } catch (error) {
    logger.warn('[db] KB FTS 自检失败（非致命）', error)
  }

  // vec_dim 漂移自检（§九风险3）：存量向量维度 ≠ 当前 provider 维度 → 标记需重嵌。
  // 不在此触发重嵌（重嵌是分钟级后台任务，走 kb:reindex），仅写 app_meta 标志 + warn。
  // 预期维度不在此硬编码——单值漂移由 embed.ts checkVecDimDrift 用
  // provider.dimension() 与库内 vec_dim 比对判定（避免双源漂移）。
  try {
    const driftRow = db
      .prepare(
        'SELECT DISTINCT vec_dim FROM kb_chunks WHERE vec IS NOT NULL AND vec_dim IS NOT NULL',
      )
      .all() as { vec_dim: number }[]
    const dims = driftRow.map((r) => r.vec_dim)
    if (dims.length > 1) {
      // 库内同时存在多种维度 → 必然漂移（换 provider 未重嵌）
      logger.warn(`[db] KB 向量维度不一致：${dims.join(',')}，需 kb:reindex 重嵌`)
      setAppMeta('kb_reindex_required', '1')
    }
  } catch (error) {
    logger.warn('[db] KB vec_dim 漂移自检失败（非致命）', error)
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
