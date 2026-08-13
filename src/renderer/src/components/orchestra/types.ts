import type { CreateDraft, SessionMessage } from '@shared/types'
import type { CardStatus } from '@renderer/components/CreateConfirmCard'
import type { ProposalErrorInfo } from '@renderer/components/CreateProposalErrorCard'
import type { CreateNoticeInfo } from '@renderer/components/CreateNoticeBar'
import type { OrbState } from '@renderer/components/ThinkingOrb'

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
  /** propose_* 失败卡 */
  proposalError?: ProposalErrorInfo
  /** 创建链路系统提示（补跑等） */
  createNotice?: CreateNoticeInfo
  /** 编排发言者（orch_event output 气泡，executor_id == agent name） */
  speaker?: string
  /** HITL 提问卡（request_info 事件生成）；与 text 互斥 */
  askUser?: AskUserPrompt
  /** HITL 工具审批卡（approval_request 事件生成）；与 text 互斥 */
  approval?: ApprovalPrompt
  /** ThinkingOrb 动画状态（流式期间显示何种思考球动画） */
  orbState?: OrbState
  /** 工具调用记录（tool_call/tool_result 事件积累，按时间排序） */
  toolCalls?: ToolCallInfo[]
  /** 节点执行状态记录（node_started/node_done/node_error 事件积累） */
  nodeStates?: NodeStateInfo[]
  /** 消息创建时间戳（首 token/thinking 到达时） */
  createdAt?: number
  /** 消息完成时间戳（streaming 结束时） */
  completedAt?: number
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

/** 工具审批卡数据（approval_request → pending；approval_resolved → approved/denied/expired） */
export interface ApprovalPrompt {
  requestId: string
  nodeId: string
  toolName: string
  args: unknown
  status: 'pending' | 'approved' | 'denied' | 'expired'
  /** 用户点了「本会话允许」（后续同工具不再弹窗） */
  sessionWide?: boolean
}

/** 工具调用信息（tool_call/tool_result 事件的结构化记录） */
export interface ToolCallInfo {
  id: string
  tool: string
  argsSummary: string       // 入参摘要，截断 200 字符
  resultSummary?: string    // 返回值摘要，截断 200 字符
  status: 'pending' | 'done' | 'error'
  timestamp: number
}

/** 节点执行状态（node_started/node_done/node_error 事件记录） */
export interface NodeStateInfo {
  nodeId: string
  status: 'running' | 'done' | 'error'
  startedAt: number
  endedAt?: number
  error?: string
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
      createdAt: m.createdAt,
    }
  })
}
