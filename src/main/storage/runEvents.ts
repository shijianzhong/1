import { getDb } from './db'
import { logger } from '../logger'

// —— 运行时事实流存储层（docs/DEEPSEEK_HARNESS_LEARNING_PLAN.md P0，修订 3 先窄后宽）——
// 设计约束：
// 1. 观测层不打断业务：所有写函数内部 try/catch → logger.error，绝不向上抛。
//    （事件写失败只损失诊断能力，不能反过来弄挂用户的一次运行。）
// 2. runId 为空 = 无运行上下文（如工具单测、未来后台任务），合法场景，直接跳过不记日志。
// 3. seq 按 run_id 维度 MAX+1 单调递增：better-sqlite3 单连接串行同步 API，无并发竞争。
// 4. payload 一律 JSON 序列化 + 8KB 截断护栏：防大文本（工具结果全文等）灌爆 DB。
//    需要全文时用 id/摘要回查 messages 等业务表，事件只存「诊断所需最小事实」。

/** 单个事件 payload JSON 的硬上限（超出截断并标记，防观测数据膨胀） */
const PAYLOAD_JSON_CAP = 8 * 1024

export type RunEntry = 'home' | 'editor'
export type RunRoute = 'direct' | 'team' | 'directAgent' | 'focusCap'
export type RunStatus = 'running' | 'completed' | 'error' | 'aborted'

export interface RunRow {
  id: string
  session_id: string | null
  entry: string
  route: string | null
  status: string
  started_at: number
  ended_at: number | null
}

export interface RunEventRow {
  id: number
  run_id: string
  session_id: string | null
  seq: number
  type: string
  payload: string | null
  created_at: number
}

/** 序列化 payload；超护栏截断并留标记（截断后仍是合法 JSON） */
function serializePayload(payload: unknown): string | null {
  if (payload === undefined || payload === null) return null
  let json: string
  try {
    json = JSON.stringify(payload)
  } catch (error) {
    // 含循环引用等不可序列化对象：降级为错误占位，不吞也不炸
    logger.warn('[runEvents] payload 序列化失败', error)
    return JSON.stringify({ __unserializable: true })
  }
  if (json.length <= PAYLOAD_JSON_CAP) return json
  return JSON.stringify({
    __truncated: true,
    originalBytes: json.length,
    preview: json.slice(0, PAYLOAD_JSON_CAP),
  })
}

/** 登记一次运行的开始（entry=入口；route 待路由决策后由 setRunRoute 回填） */
export function startRun(input: {
  id: string
  sessionId?: string
  entry: RunEntry
}): void {
  try {
    getDb()
      .prepare('INSERT INTO runs (id, session_id, entry, status, started_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.id, input.sessionId ?? null, input.entry, 'running', Date.now())
  } catch (error) {
    logger.error(`[runEvents] startRun 失败 run=${input.id}`, error)
  }
}

/** 回填路由决策（直答/组队/直跳角色/聚焦能力；editor 入口无路由决策，不调） */
export function setRunRoute(runId: string, route: RunRoute): void {
  try {
    getDb().prepare('UPDATE runs SET route = ? WHERE id = ?').run(route, runId)
  } catch (error) {
    logger.error(`[runEvents] setRunRoute 失败 run=${runId}`, error)
  }
}

/** 收口运行状态（completed/error/aborted）；重复收口只首次生效（防 finally 双写） */
export function endRun(runId: string, status: Exclude<RunStatus, 'running'>): void {
  try {
    getDb()
      .prepare("UPDATE runs SET status = ?, ended_at = ? WHERE id = ? AND status = 'running'")
      .run(status, Date.now(), runId)
  } catch (error) {
    logger.error(`[runEvents] endRun 失败 run=${runId}`, error)
  }
}

/**
 * 追加一条事实事件。runId 为空（无运行上下文）直接跳过——合法场景不记日志。
 * 写入失败 logger.error 不抛（观测层不打断业务主流程）。
 */
export function appendRunEvent(
  runId: string | undefined,
  type: string,
  payload?: unknown,
  sessionId?: string,
): void {
  if (!runId) return
  try {
    const db = getDb()
    const row = db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_events WHERE run_id = ?')
      .get(runId) as { next: number }
    db.prepare(
      'INSERT INTO run_events (run_id, session_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(runId, sessionId ?? null, row.next, type, serializePayload(payload), Date.now())
  } catch (error) {
    logger.error(`[runEvents] appendRunEvent 失败 run=${runId} type=${type}`, error)
  }
}

/** 查询单个 run（不存在返回 null） */
export function getRun(runId: string): RunRow | null {
  const row = getDb().prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined
  return row ?? null
}

/** 列出 run（可按 session 过滤；默认按开始时间倒序取最近 limit 条） */
export function listRuns(opts: { sessionId?: string; limit?: number } = {}): RunRow[] {
  const limit = opts.limit ?? 50
  if (opts.sessionId) {
    return getDb()
      .prepare('SELECT * FROM runs WHERE session_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(opts.sessionId, limit) as RunRow[]
  }
  return getDb()
    .prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?')
    .all(limit) as RunRow[]
}

/** 拉出一个 run 的完整事件时间线（按 seq 升序） */
export function listRunEvents(runId: string): RunEventRow[] {
  return getDb()
    .prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY seq ASC')
    .all(runId) as RunEventRow[]
}
