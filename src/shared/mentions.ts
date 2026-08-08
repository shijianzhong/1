/**
 * 稳定资产引用 token（PROJECT_REVIEW P0）。
 * 线格式：`@[agent|capability|skill:<id>]`
 * UI 仍展示 `@名字`；序列化与解析走 id，不再依赖展示名。
 */

export type MentionKind = 'agent' | 'capability' | 'skill'

const KINDS = new Set<string>(['agent', 'capability', 'skill'])

/** 序列化稳定 token（芯片 → 发往主进程的纯文本） */
export function formatMentionToken(kind: MentionKind, id: string): string {
  return `@[${kind}:${id}]`
}

/** 解析 `@[kind:id]`；非法则 null */
export function parseMentionToken(
  raw: string,
): { kind: MentionKind; id: string } | null {
  const m = /^@\[(agent|capability|skill):([^\]]+)\]$/.exec(raw)
  if (!m) return null
  const kind = m[1]
  const id = m[2]
  if (!KINDS.has(kind) || !id) return null
  return { kind: kind as MentionKind, id }
}

/** 匹配文本中全部稳定 token（全局） */
export const MENTION_TOKEN_RE = /@\[(agent|capability|skill):([^\]]+)\]/g

/** 旧版展示名协议（兼容手打 / 历史消息） */
export const MENTION_NAME_RE = /@([\w\u4e00-\u9fa5-]+)/g
