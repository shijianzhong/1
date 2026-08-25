import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import type { LlmContentBlock, LlmMessage, Session, SessionMessage } from '@shared/types'

// —— 会话/消息 SQLite CRUD（§5.2.3 schema）——

export function createSession(input: {
  title: string
  userId?: string
  capabilityId?: string
  cwd?: string
}): Session {
  const now = Date.now()
  const session: Session = {
    id: randomUUID(),
    userId: input.userId ?? 'local',
    title: input.title,
    capabilityId: input.capabilityId,
    cwd: input.cwd,
    createdAt: now,
    updatedAt: now,
  }
  getDb()
    .prepare(
      `INSERT INTO sessions (id, user_id, title, capability_id, cwd, created_at, updated_at)
       VALUES (@id, @userId, @title, @capabilityId, @cwd, @createdAt, @updatedAt)`,
    )
    .run({ ...session, cwd: session.cwd ?? null })
  return session
}

export function listSessions(userId = 'local'): Session[] {
  return getDb()
    .prepare(
      `SELECT id, user_id as userId, title, capability_id as capabilityId, cwd,
              created_at as createdAt, updated_at as updatedAt
       FROM sessions WHERE user_id = ? ORDER BY updated_at DESC`,
    )
    .all(userId) as Session[]
}

export function getSession(id: string): Session | null {
  return (
    (getDb()
      .prepare(
        `SELECT id, user_id as userId, title, capability_id as capabilityId, cwd,
                created_at as createdAt, updated_at as updatedAt
         FROM sessions WHERE id = ?`,
      )
      .get(id) as Session | undefined) ?? null
  )
}

export function renameSession(id: string, title: string): void {
  getDb().prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?').run(
    title,
    Date.now(),
    id,
  )
}

export function removeSession(id: string): void {
  const db = getDb()
  // messages 走外键 ON DELETE CASCADE；memory_l1/l2 无外键，需手动级联（观察点：防孤儿数据）
  // 三 DELETE 必须原子：中途崩溃会留孤儿 memory_l1/l2 行（session 已删但摘要残留）→
  // 下次启动无法通过 session 关联回收，且列表/检索出现幽灵摘要。包 db.transaction 保证全成或全废。
  db.transaction(() => {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    db.prepare('DELETE FROM memory_l1 WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM memory_l2 WHERE session_id = ?').run(id)
  })()
}

// —— 消息 ——

export function addMessage(input: {
  sessionId: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  meta?: unknown
}): SessionMessage {
  const db = getDb()
  const msg: SessionMessage = {
    id: randomUUID(),
    sessionId: input.sessionId,
    role: input.role,
    content: input.content,
    meta: input.meta,
    createdAt: Date.now(),
  }
  // INSERT 消息 + touchSession(updated_at) 必须原子：中途崩溃会出现「消息已入库但 sessions.updated_at
  // 未更新」→ 列表按 updated_at 排序时该会话沉底/不置顶，用户以为没收到回复。
  db.transaction(() => {
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, meta, created_at)
       VALUES (@id, @sessionId, @role, @content, @meta, @createdAt)`,
    ).run({ ...msg, meta: msg.meta ? JSON.stringify(msg.meta) : null })
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), input.sessionId)
  })()
  return msg
}

export function listMessages(sessionId: string): SessionMessage[] {
  return getDb()
    .prepare(
      `SELECT id, session_id as sessionId, role, content, meta, created_at as createdAt
       FROM messages WHERE session_id = ? ORDER BY created_at ASC`,
    )
    .all(sessionId)
    .map((r) => {
      const row = r as SessionMessage & { meta: string | null }
      return {
        ...row,
        meta: row.meta ? JSON.parse(row.meta) : undefined,
      }
    }) as SessionMessage[]
}

/**
 * SessionMessage[] → LlmMessage[] 映射（home / orchestrate 共用）。
 * meta.structured=true 的 content 是 JSON-stringified LlmContentBlock[]
 * （tool_use / tool_result 块），需还原为结构化 content 供 LLM 看到完整工具调用上下文；
 * role 'tool' → 'user'（Anthropic 不接受 tool role）。非结构化原样取 content。
 */
export function toLlmMessages(rows: SessionMessage[]): LlmMessage[] {
  return rows.map((m) => {
    const meta = m.meta as { structured?: boolean; intermediate?: boolean } | undefined
    if (meta?.structured) {
      return {
        role: (m.role === 'tool' ? 'user' : m.role) as LlmMessage['role'],
        content: JSON.parse(m.content) as LlmContentBlock[],
      }
    }
    return {
      role: (m.role === 'tool' ? 'user' : m.role) as LlmMessage['role'],
      content: m.content,
    }
  })
}

/** 合并更新消息 meta（聊天创建 confirm 后写 status=confirmed 等） */
export function updateMessageMeta(messageId: string, patch: Record<string, unknown>): SessionMessage | null {
  const row = getDb()
    .prepare(
      `SELECT id, session_id as sessionId, role, content, meta, created_at as createdAt
       FROM messages WHERE id = ?`,
    )
    .get(messageId) as (SessionMessage & { meta: string | null }) | undefined
  if (!row) return null
  const prev = row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {}
  const next = { ...prev, ...patch }
  getDb()
    .prepare('UPDATE messages SET meta = ? WHERE id = ?')
    .run(JSON.stringify(next), messageId)
  return { ...row, meta: next }
}

/** 按创建草稿 id 查找带 meta.create.draftId 的消息（confirmCreate 用） */
export function findMessageByCreateDraftId(
  sessionId: string,
  draftId: string,
): SessionMessage | null {
  for (const m of listMessages(sessionId)) {
    const create = (m.meta as { create?: { draftId?: string } } | undefined)?.create
    if (create?.draftId === draftId) return m
  }
  return null
}
