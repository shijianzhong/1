import type { CreateDraft, SessionMessage } from '@shared/types'
import type { CardStatus } from '@renderer/components/CreateConfirmCard'

// —— 编排聊天共享类型（HomePage 与 EditorPage 运行面板共用）——
// 「编辑器运行 == 首页 @能力 运行」从组件层保证：同一消息模型 + 同一 reducer + 同一气泡。

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
  error?: boolean
  retrying?: string
  thinking?: string
  thinkingCollapsed?: boolean // 回复完成后自动折叠
  /** 创建提案草稿（渲染确认卡）；与 text 互斥 */
  draft?: CreateDraft
  /** 确认卡状态（pending 可交互；saved/cancelled 定格） */
  cardStatus?: CardStatus
  /** 编排发言者（orch_event output 气泡，executor_id == agent name） */
  speaker?: string
  /** HITL 提问卡（request_info 事件生成）；与 text 互斥 */
  askUser?: AskUserPrompt
}

/** ask_user 提问卡数据（request_info → pending；request_resolved → answered/expired） */
export interface AskUserPrompt {
  requestId: string
  nodeId: string
  question: string
  context?: string
  status: 'pending' | 'answered' | 'expired'
  /** 用户作答内容（answered 时有值） */
  response?: string
}

/** 把历史消息转成 ChatMessage（用于渲染） */
export function toChatMessages(msgs: SessionMessage[]): ChatMessage[] {
  return msgs.map((m) => {
    const thinking = (m.meta as { thinking?: string } | undefined)?.thinking
    return {
      id: m.id,
      role: m.role === 'tool' ? 'user' : (m.role as 'user' | 'assistant'),
      text: m.content,
      // 历史消息的 thinking 默认折叠（用户可展开查看）
      thinking: thinking || undefined,
      thinkingCollapsed: thinking ? true : undefined,
    }
  })
}
