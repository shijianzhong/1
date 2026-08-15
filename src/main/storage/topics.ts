import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import type { Topic, TopicMeta, TopicStatus, TopicRecommendation } from '@shared/types'

// —— 选题库 CRUD（SQLite topics 表，v7 迁移；docs/CONTENT_PIPELINE_PLAN.md §2.3）——
// 仿 sessions.ts 范式。meta/tags 走 JSON 列。

export function createTopic(input: {
  title: string
  userId?: string
  direction?: string
  status?: TopicStatus
  recommendation?: TopicRecommendation
  meta?: TopicMeta
  tags?: string[]
}): Topic {
  const now = Date.now()
  const topic: Topic = {
    id: randomUUID(),
    userId: input.userId ?? 'local',
    title: input.title,
    direction: input.direction,
    status: input.status ?? 'pending',
    recommendation: input.recommendation,
    meta: input.meta,
    tags: input.tags,
    createdAt: now,
    updatedAt: now,
  }
  getDb()
    .prepare(
      `INSERT INTO topics (id, user_id, title, direction, status, recommendation, meta, tags, created_at, updated_at)
       VALUES (@id, @userId, @title, @direction, @status, @recommendation, @meta, @tags, @createdAt, @updatedAt)`,
    )
    .run({
      ...topic,
      direction: topic.direction ?? null,
      status: topic.status,
      recommendation: topic.recommendation ?? null,
      meta: topic.meta ? JSON.stringify(topic.meta) : null,
      tags: topic.tags ? JSON.stringify(topic.tags) : null,
    })
  return topic
}

export function listTopics(opts?: {
  userId?: string
  status?: TopicStatus
  direction?: string
}): Topic[] {
  const conditions: string[] = ['user_id = @userId']
  const params: Record<string, unknown> = { userId: opts?.userId ?? 'local' }
  if (opts?.status) {
    conditions.push('status = @status')
    params.status = opts.status
  }
  if (opts?.direction) {
    conditions.push('direction = @direction')
    params.direction = opts.direction
  }
  return getDb()
    .prepare(
      `SELECT id, user_id as userId, title, direction, status, recommendation, meta, tags,
              created_at as createdAt, updated_at as updatedAt
       FROM topics WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC`,
    )
    .all(params)
    .map((row) => deserializeTopic(row)) as Topic[]
}

export function getTopic(id: string): Topic | null {
  const row = getDb()
    .prepare(
      `SELECT id, user_id as userId, title, direction, status, recommendation, meta, tags,
              created_at as createdAt, updated_at as updatedAt
       FROM topics WHERE id = ?`,
    )
    .get(id) as Topic | undefined
  return row ? deserializeTopic(row) : null
}

export function updateTopic(
  id: string,
  patch: Partial<{
    title: string
    direction: string
    status: TopicStatus
    recommendation: TopicRecommendation
    meta: TopicMeta
    tags: string[]
  }>,
): Topic | null {
  const existing = getTopic(id)
  if (!existing) return null
  const now = Date.now()
  const next: Topic = {
    ...existing,
    ...patch,
    meta: patch.meta !== undefined ? patch.meta : existing.meta,
    tags: patch.tags !== undefined ? patch.tags : existing.tags,
    updatedAt: now,
  }
  getDb()
    .prepare(
      `UPDATE topics
       SET title = @title, direction = @direction, status = @status, recommendation = @recommendation,
           meta = @meta, tags = @tags, updated_at = @updatedAt
       WHERE id = @id`,
    )
    .run({
      id: next.id,
      title: next.title,
      direction: next.direction ?? null,
      status: next.status,
      recommendation: next.recommendation ?? null,
      meta: next.meta ? JSON.stringify(next.meta) : null,
      tags: next.tags ? JSON.stringify(next.tags) : null,
      updatedAt: now,
    })
  return next
}

export function removeTopic(id: string): void {
  getDb().prepare('DELETE FROM topics WHERE id = ?').run(id)
}

/** 反序列化：meta/tags JSON 列 → 对象 */
function deserializeTopic(row: unknown): Topic {
  const r = row as Record<string, unknown>
  return {
    ...(r as unknown as Topic),
    meta: r.meta ? (JSON.parse(r.meta as string) as TopicMeta) : undefined,
    tags: r.tags ? (JSON.parse(r.tags as string) as string[]) : undefined,
  }
}
