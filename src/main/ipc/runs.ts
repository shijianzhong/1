import { withHandler } from './handler'
import { getRun, listRunEvents, listRuns, type RunRow } from '../storage/runEvents'
import type { RunEventInfo, RunInfo } from '@shared/types'

// —— run diagnostics 查询层（docs/DEEPSEEK_HARNESS_LEARNING_PLAN.md P0 第 3 项）——
// 只读通道：把 runs/run_events 暴露给渲染层做时间线查看与导出。
// payload 在主进程解析成对象（渲染层直接渲染；解析失败回退 raw 字符串，不吞错）。

function toRunInfo(row: RunRow): RunInfo {
  return {
    id: row.id,
    sessionId: row.session_id,
    entry: row.entry,
    route: row.route,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  }
}

function toEventInfo(row: {
  id: number
  run_id: string
  session_id: string | null
  seq: number
  type: string
  payload: string | null
  created_at: number
}): RunEventInfo {
  let payload: unknown = null
  if (row.payload !== null) {
    try {
      payload = JSON.parse(row.payload)
    } catch {
      payload = { __raw: row.payload }
    }
  }
  return {
    id: row.id,
    runId: row.run_id,
    sessionId: row.session_id,
    seq: row.seq,
    type: row.type,
    payload,
    createdAt: row.created_at,
  }
}

export function registerRunsHandlers(): void {
  // 列出 run（可按 session 过滤；默认最近 50 条）
  withHandler<RunInfo[]>('runs:list', (_e, input) => {
    const { sessionId, limit } = (input ?? {}) as { sessionId?: string; limit?: number }
    return listRuns({ sessionId, limit }).map(toRunInfo)
  })

  // 单个 run + 完整事件时间线（按 seq 升序）
  withHandler<{ run: RunInfo | null; events: RunEventInfo[] }>('runs:detail', (_e, input) => {
    const { runId } = (input ?? {}) as { runId?: string }
    if (!runId) return { run: null, events: [] }
    const run = getRun(runId)
    return {
      run: run ? toRunInfo(run) : null,
      events: listRunEvents(runId).map(toEventInfo),
    }
  })
}
