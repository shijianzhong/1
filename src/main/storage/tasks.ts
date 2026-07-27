import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import type { TaskRecord, WorkflowGraph } from '@shared/types'

// —— 任务历史 SQLite CRUD（§5.2.3 schema）——

export function createTask(input: {
  userId?: string
  sessionId?: string
  capabilityId?: string
  graph?: WorkflowGraph
}): TaskRecord {
  const now = Date.now()
  const task: TaskRecord = {
    id: randomUUID(),
    userId: input.userId ?? 'local',
    sessionId: input.sessionId,
    capabilityId: input.capabilityId,
    status: 'pending',
    graph: input.graph,
    createdAt: now,
    updatedAt: now,
  }
  getDb()
    .prepare(
      `INSERT INTO tasks (id, user_id, session_id, capability_id, status, graph, created_at, updated_at)
       VALUES (@id, @userId, @sessionId, @capabilityId, @status, @graph, @createdAt, @updatedAt)`,
    )
    .run({
      ...task,
      graph: task.graph ? JSON.stringify(task.graph) : null,
    })
  return task
}

export function listTasks(userId = 'local'): TaskRecord[] {
  return getDb()
    .prepare(
      `SELECT id, user_id as userId, session_id as sessionId, capability_id as capabilityId,
              status, graph, result, error, created_at as createdAt, updated_at as updatedAt
       FROM tasks WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .all(userId)
    .map((r) => {
      const row = r as TaskRecord & { graph: string | null; result: string | null }
      return {
        ...row,
        graph: row.graph ? JSON.parse(row.graph) : undefined,
        result: row.result ? JSON.parse(row.result) : undefined,
      }
    }) as TaskRecord[]
}

export function getTask(id: string): TaskRecord | null {
  const row = getDb()
    .prepare(
      `SELECT id, user_id as userId, session_id as sessionId, capability_id as capabilityId,
              status, graph, result, error, created_at as createdAt, updated_at as updatedAt
       FROM tasks WHERE id = ?`,
    )
    .get(id) as (TaskRecord & { graph: string | null; result: string | null }) | undefined
  if (!row) return null
  return {
    ...row,
    graph: row.graph ? JSON.parse(row.graph) : undefined,
    result: row.result ? JSON.parse(row.result) : undefined,
  }
}

export function updateTaskStatus(
  id: string,
  status: TaskRecord['status'],
  extra?: { result?: unknown; error?: string },
): void {
  getDb()
    .prepare(
      `UPDATE tasks SET status = ?, result = ?, error = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      status,
      extra?.result ? JSON.stringify(extra.result) : null,
      extra?.error ?? null,
      Date.now(),
      id,
    )
}
