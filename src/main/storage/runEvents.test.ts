import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// —— runEvents 存储层单测（内存库 + vi.mock getDb，同 l3.test.ts 模式）——

let memDb: Database.Database

// 注意：本文件在 storage/ 根目录，mock 路径是 './db'（不是 l3.test.ts 的 '../db'）——
// 写错会导致 mock 静默失效、getDb 走真实文件库（/tmp/one-test-userdata），状态跨用例累积。
vi.mock('./db', () => ({
  getDb: () => memDb,
}))

const {
  startRun,
  setRunRoute,
  endRun,
  appendRunEvent,
  getRun,
  listRuns,
  listRunEvents,
} = await import('./runEvents')

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      entry TEXT NOT NULL,
      route TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE TABLE run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      session_id TEXT,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_run_events_run_seq ON run_events(run_id, seq);
  `)
  return db
}

beforeEach(() => {
  memDb = freshDb()
})

describe('startRun / getRun / setRunRoute / endRun', () => {
  it('完整生命周期：开始 → 回填路由 → 收口', () => {
    startRun({ id: 'r1', sessionId: 's1', entry: 'home' })
    const running = getRun('r1')
    expect(running?.status).toBe('running')
    expect(running?.entry).toBe('home')
    expect(running?.route).toBeNull()
    expect(running?.ended_at).toBeNull()

    setRunRoute('r1', 'team')
    expect(getRun('r1')?.route).toBe('team')

    endRun('r1', 'completed')
    const done = getRun('r1')
    expect(done?.status).toBe('completed')
    expect(done?.ended_at).toBeTypeOf('number')
  })

  it('endRun 重复收口只首次生效（防 finally 双写覆盖 error 为 completed）', () => {
    startRun({ id: 'r1', entry: 'editor' })
    endRun('r1', 'error')
    endRun('r1', 'completed')
    expect(getRun('r1')?.status).toBe('error')
  })

  it('getRun 不存在返回 null', () => {
    expect(getRun('nope')).toBeNull()
  })

  it('startRun 失败（如重复 id）不抛异常', () => {
    startRun({ id: 'r1', entry: 'home' })
    expect(() => startRun({ id: 'r1', entry: 'home' })).not.toThrow()
  })

  // CODE_REVIEW P0 契约：startRun 之后、内层 try 之前抛异常（如 home.chat 的
  // provider 缺失 IpcErrorThrow）时，外层 catch 的 endRun('error') 必须能把 run 行
  // 从 'running' 收口为 'error'——这是「run 行不永久卡 running」的存储层前提。
  // 控制流保证（外层 try 包住 startRun 之后全部代码）在 home.ts/orchestrate.ts，
  // 此处锁定存储层在「startRun 后立即异常 → 补一个 endRun」模式下行为正确。
  it('startRun 后立即异常 → 外层 catch 调 endRun：run 行收口为 error 而非卡 running', () => {
    startRun({ id: 'r1', sessionId: 's1', entry: 'home' })
    expect(getRun('r1')?.status).toBe('running')
    // 模拟 startRun 之后、内层 try 之前抛异常，外层 catch 的收口调用
    try {
      throw new Error('pre_inner_try boom')
    } catch {
      endRun('r1', 'error')
    }
    const done = getRun('r1')
    expect(done?.status).toBe('error')
    expect(done?.ended_at).toBeTypeOf('number')
  })
})

describe('appendRunEvent', () => {
  it('seq 按 run 维度单调递增（两 run 各自从 1 开始）', () => {
    startRun({ id: 'r1', entry: 'home' })
    startRun({ id: 'r2', entry: 'home' })
    appendRunEvent('r1', 'a')
    appendRunEvent('r1', 'b')
    appendRunEvent('r2', 'a')
    const e1 = listRunEvents('r1')
    const e2 = listRunEvents('r2')
    expect(e1.map((e) => e.seq)).toEqual([1, 2])
    expect(e1.map((e) => e.type)).toEqual(['a', 'b'])
    expect(e2.map((e) => e.seq)).toEqual([1])
  })

  it('payload 序列化为 JSON，读取端可还原', () => {
    startRun({ id: 'r1', entry: 'home' })
    appendRunEvent('r1', 'home.route.decided', { decision: 'team', roles: ['a', 'b'] }, 's1')
    const events = listRunEvents('r1')
    expect(events[0].session_id).toBe('s1')
    expect(JSON.parse(events[0].payload!)).toEqual({ decision: 'team', roles: ['a', 'b'] })
  })

  it('runId 为空直接跳过（无运行上下文的合法场景），不写库不报错', () => {
    appendRunEvent(undefined, 'tool.started', { tool: 'x' })
    expect(listRunEvents('anything')).toEqual([])
  })

  it('payload 超 8KB 护栏截断并留标记', () => {
    startRun({ id: 'r1', entry: 'home' })
    appendRunEvent('r1', 'tool.completed', { big: 'x'.repeat(16 * 1024) })
    const payload = JSON.parse(listRunEvents('r1')[0].payload!)
    expect(payload.__truncated).toBe(true)
    expect(payload.originalBytes).toBeGreaterThan(8 * 1024)
  })

  it('写入失败（如表不存在）不抛异常', () => {
    memDb.exec('DROP TABLE run_events')
    expect(() => appendRunEvent('r1', 'a')).not.toThrow()
  })

  it('孤儿事件可落库（run 行不存在时事件仍写，观测层松耦合）', () => {
    appendRunEvent('ghost-run', 'tool.started', { tool: 'x' })
    expect(listRunEvents('ghost-run')).toHaveLength(1)
  })
})

describe('listRuns', () => {
  it('按 session 过滤 + 倒序 + limit', () => {
    startRun({ id: 'r1', sessionId: 's1', entry: 'home' })
    startRun({ id: 'r2', sessionId: 's1', entry: 'home' })
    startRun({ id: 'r3', sessionId: 's2', entry: 'editor' })
    const s1Runs = listRuns({ sessionId: 's1' })
    expect(s1Runs.map((r) => r.id).sort()).toEqual(['r1', 'r2'])
    expect(listRuns({ limit: 1 })).toHaveLength(1)
  })
})
