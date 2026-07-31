import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Bot } from 'lucide-react'

// —— Agent 节点视觉（借鉴 Proton AgentNodeView）——
// 实线边框、品牌色、显示角色名/模型/状态。
// Agent 节点拖入画布时快照全局 Agent 配置到节点 data，之后节点级独立可改（解耦）。
// sourceAgentId 是软引用（回溯模板来源），不用于运行时查找。

export type AgentNodeStatus = 'idle' | 'running' | 'done' | 'error'

export interface AgentNodeData {
  label: string
  kind: 'agent'
  /** 软引用：拖入时来源的全局 Agent ID（仅用于回溯模板，不用于运行时查找） */
  sourceAgentId?: string
  /** 节点级独立配置（快照 + 可叠加修改） */
  instructions?: string
  description?: string
  skillIds?: string[]
  modelId?: string
  temperature?: number
  maxTokens?: number
  outputConstraints?: string
  /** 画布 UI 字段 */
  model?: string
  status?: AgentNodeStatus
  isEntry?: boolean
  /** 派生：当前生效入口标记（displayNodes 注入，不入库） */
  effectiveEntry?: boolean
  /** 派生：生效入口是否来自拓扑推导（true=推导，false=显式） */
  entryDerived?: boolean
  [key: string]: unknown
}

const STATUS_LABEL: Record<AgentNodeStatus, string> = {
  idle: '待机',
  running: '运行中',
  done: '完成',
  error: '错误',
}

function AgentNodeViewImpl({ data, selected }: NodeProps) {
  const d = data as AgentNodeData
  const status = d.status ?? 'idle'

  return (
    <div
      className={`rf-agent-node rf-status--${status}${selected ? ' rf-node--selected' : ''}`}
    >
      <Handle type="target" position={Position.Left} className="rf-handle" />

      {d.isEntry ? <span className="rf-entry-badge">入口</span> : null}
      {!d.isEntry && d.effectiveEntry && d.entryDerived ? (
        <span className="rf-entry-badge rf-entry-badge--derived">入口·推导</span>
      ) : null}

      <div className="rf-agent-node__header">
        <span className="rf-agent-node__icon">
          <Bot size={14} />
        </span>
        <span className="rf-agent-node__title">{d.label}</span>
      </div>

      <div className="rf-agent-node__meta">
        <span className="rf-agent-node__status">{STATUS_LABEL[status]}</span>
        {d.model ? (
          <span className="rf-agent-node__model">{d.model}</span>
        ) : null}
      </div>

      <Handle type="source" position={Position.Right} className="rf-handle" />
    </div>
  )
}

export const AgentNodeView = memo(AgentNodeViewImpl)
