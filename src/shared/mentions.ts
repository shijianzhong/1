/**
 * 资产 @ 提及协议。
 *
 * - **展示 / 落库**：`@名字`（对话记录好看）
 * - **芯片 → 主进程**：另传 `{kind,id}` 显式映射（稳定，不靠名字）
 * - **兼容**：正文里仍可出现 `@[agent|capability|skill:<id>]`（历史消息 / 粘贴）
 */

export type MentionKind = 'agent' | 'capability' | 'skill'

export interface ExplicitMention {
  kind: MentionKind
  id: string
}

const KINDS = new Set<string>(['agent', 'capability', 'skill'])

/** 稳定 token（解析兼容；新发送不再用它做展示） */
export function formatMentionToken(kind: MentionKind, id: string): string {
  return `@[${kind}:${id}]`
}

/** 展示形态：`@名字` */
export function formatMentionDisplay(name: string): string {
  return `@${name}`
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

/** 旧版 / 展示名协议（手打与芯片 `@名字`） */
export const MENTION_NAME_RE = /@([\w\u4e00-\u9fa5-]+)/g

/**
 * 把正文里的 `@[kind:id]` 换成 `@名字`（历史消息展示用）。
 * 查不到名字则保留原 token。
 */
export function mentionTokensToDisplay(
  text: string,
  lookup: (kind: MentionKind, id: string) => string | undefined,
): string {
  return text.replace(MENTION_TOKEN_RE, (full, kind: string, id: string) => {
    if (!KINDS.has(kind)) return full
    const name = lookup(kind as MentionKind, id)
    return name ? formatMentionDisplay(name) : full
  })
}
