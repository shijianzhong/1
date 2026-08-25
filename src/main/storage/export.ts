import type { LlmContentBlock, SessionMessage } from '@shared/types'
import { getSession, listMessages } from './sessions'

// —— 会话导出为 Markdown（§亮点②：会话导出与回放）——
// messagesToMarkdown 为纯函数（无 DB 依赖），便于单测锁行为；sessionToMarkdown 是其
// 带 DB 读取的薄包装。渲染对齐 toLlmMessages 的语义：meta.structured=true 的 content
// 是 JSON-stringified LlmContentBlock[]（text / tool_use / tool_result 等块）。

const ROLE_LABEL: Record<SessionMessage['role'], string> = {
  user: '👤 用户',
  assistant: '🤖 助手',
  tool: '🔧 工具',
}

function renderBlock(block: LlmContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'tool_use':
      return `> **🔧 调用工具 \`${block.name}\`**\n\n\`\`\`json\n${JSON.stringify(block.input, null, 2)}\n\`\`\``
    case 'tool_result':
      return `> **📦 工具结果**${block.is_error ? '（错误）' : ''}\n\n\`\`\`\n${block.content}\n\`\`\``
    case 'thinking':
      return `> 💭 *${block.thinking}*`
    case 'image':
      return '> 🖼️ [图片]'
    default:
      return ''
  }
}

export interface SessionExportOptions {
  /** 标题（会话标题），非空时作为一级标题 */
  title?: string
  /** 导出时间戳（会话创建时间），非空时附一行导出元信息 */
  createdAt?: number
}

/** 把一组会话消息渲染为 Markdown。结构化消息（meta.structured）还原工具调用块。 */
export function messagesToMarkdown(
  messages: SessionMessage[],
  opts: SessionExportOptions = {},
): string {
  const parts: string[] = []

  if (opts.title) {
    parts.push(`# ${opts.title}`)
    if (opts.createdAt !== undefined) {
      parts.push(`> 导出时间：${new Date(opts.createdAt).toLocaleString()}`)
    }
    parts.push('')
  }

  for (const m of messages) {
    const meta = m.meta as { structured?: boolean } | undefined
    let body: string
    if (meta?.structured) {
      let blocks: LlmContentBlock[] = []
      try {
        blocks = JSON.parse(m.content) as LlmContentBlock[]
      } catch {
        blocks = []
      }
      body = blocks.map(renderBlock).filter(Boolean).join('\n\n')
    } else {
      body = m.content
    }
    parts.push(`### ${ROLE_LABEL[m.role]}\n\n${body}`)
  }

  if (parts.length === 0) return ''
  return parts.join('\n\n').trimEnd() + '\n'
}

/** 读取会话并导出为 Markdown；会话不存在返回空串。 */
export function sessionToMarkdown(sessionId: string): string {
  const session = getSession(sessionId)
  if (!session) return ''
  return messagesToMarkdown(listMessages(sessionId), {
    title: session.title,
    createdAt: session.createdAt,
  })
}
