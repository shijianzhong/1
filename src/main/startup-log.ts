import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { logger } from './logger'

// —— 启动分段诊断日志（独立文件，便于用户打包回传）——
// 路径：~/Library/Application Support/one/logs/startup.log
// 每次进程启动开一个 session，主/渲染 mark 都写入同一文件。

const PROCESS_ORIGIN_MS = Date.now()
const PROCESS_ORIGIN_HR = process.hrtime.bigint()

let sessionId = ''
let logPath = ''
let sessionStarted = false

type MarkEntry = {
  type: 'mark'
  sessionId: string
  phase: string
  t: number
  wall: string
  [k: string]: unknown
}

/** ready 前产生的 mark 先入队 */
const pending: MarkEntry[] = []

function elapsedMs(): number {
  return Number(process.hrtime.bigint() - PROCESS_ORIGIN_HR) / 1e6
}

function writeLine(line: string): void {
  if (!logPath) return
  try {
    appendFileSync(logPath, line + '\n', 'utf8')
  } catch (error) {
    logger.warn('[startup] 写 startup.log 失败', error)
  }
}

function flushPending(): void {
  for (const entry of pending) {
    entry.sessionId = sessionId
    writeLine(JSON.stringify(entry))
    logger.info(`[startup] +${entry.t}ms ${entry.phase}`)
  }
  pending.length = 0
}

/** 新进程会话头（app.whenReady 开头调一次） */
export function beginStartupSession(meta: Record<string, unknown> = {}): void {
  if (sessionStarted) return
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    logPath = join(dir, 'startup.log')
    sessionId = `S${Date.now().toString(36)}-${process.pid}`
    sessionStarted = true
  } catch (error) {
    logger.warn('[startup] 无法初始化 startup.log', error)
    return
  }

  writeLine('')
  writeLine('='.repeat(72))
  writeLine(
    JSON.stringify({
      type: 'session',
      sessionId,
      wall: new Date().toISOString(),
      processOriginWall: new Date(PROCESS_ORIGIN_MS).toISOString(),
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      execPath: process.execPath,
      ...meta,
    }),
  )
  writeLine(`# startup.log path: ${logPath}`)
  logger.info(`[startup] session ${sessionId} → ${logPath}`)
  flushPending()
}

/**
 * 记录一个启动阶段点。
 * @param phase 阶段名（main:* / renderer:*）
 * @param detail 可选附加字段
 */
export function startupMark(phase: string, detail?: Record<string, unknown>): void {
  const entry: MarkEntry = {
    type: 'mark',
    sessionId: sessionId || 'pre-session',
    phase,
    /** 相对本进程启动的毫秒 */
    t: Math.round(elapsedMs() * 10) / 10,
    wall: new Date().toISOString(),
    ...detail,
  }
  if (!sessionStarted) {
    pending.push(entry)
    return
  }
  writeLine(JSON.stringify(entry))
  logger.info(`[startup] +${entry.t}ms ${phase}`)
}

export function getStartupLogPath(): string {
  return logPath
}

/** 渲染层上报的 mark（带渲染侧 performance.now） */
export function startupMarkFromRenderer(payload: {
  phase: string
  /** 渲染进程 performance.now()（相对导航起点 / boot-mark 原点） */
  rendererT?: number
  detail?: Record<string, unknown>
}): void {
  startupMark(payload.phase, {
    source: 'renderer',
    rendererT:
      typeof payload.rendererT === 'number'
        ? Math.round(payload.rendererT * 10) / 10
        : undefined,
    ...payload.detail,
  })
}
