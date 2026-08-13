import { useState } from 'react'
import { ChevronDown, ChevronUp, Check, Loader2, AlertCircle, Workflow } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { NodeStateInfo } from './types'

/**
 * 工作流节点状态列表：在 AI 回复中展示编排流中各节点的实时执行状态。
 *
 * 数据来源：reducer 中 node_started/node_done/node_error 事件积累的 nodeStates。
 * 默认折叠显示摘要，展开后逐行显示节点名 + 状态图标 + 耗时。
 */
export function WorkflowTaskList({ nodeStates }: { nodeStates: NodeStateInfo[] }) {
  const { t } = useTranslation(['common'])
  const [expanded, setExpanded] = useState(false)

  if (!nodeStates.length) return null

  const runningCount = nodeStates.filter((ns) => ns.status === 'running').length
  const errorCount = nodeStates.filter((ns) => ns.status === 'error').length
  const doneCount = nodeStates.filter((ns) => ns.status === 'done').length

  // 摘要标签
  const summary = (() => {
    if (runningCount > 0) {
      return `${runningCount} ${t('common:node.executing')}`
    }
    if (errorCount > 0) {
      return `${doneCount}/${nodeStates.length} ${t('common:node.completed')} · ${errorCount} ${t('common:node.error')}`
    }
    return `${nodeStates.length} ${t('common:node.completed')}`
  })()

  // 计算耗时
  const formatDuration = (startedAt: number, endedAt?: number): string => {
    const end = endedAt ?? Date.now()
    const ms = end - startedAt
    if (ms < 1000) return `${ms}ms`
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
    return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`
  }

  return (
    <div className="workflow-tasks">
      <button
        type="button"
        className="workflow-tasks__header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="workflow-tasks__icon">
          {runningCount > 0 ? (
            <Loader2 size={12} className="workflow-tasks__spinner" />
          ) : errorCount > 0 ? (
            <AlertCircle size={12} />
          ) : (
            <Check size={12} />
          )}
        </span>
        <Workflow size={12} className="workflow-tasks__workflow-icon" />
        <span className="workflow-tasks__label">{summary}</span>
        {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>

      {expanded ? (
        <div className="workflow-tasks__list">
          {nodeStates.map((ns, i) => (
            <div key={`${ns.nodeId}-${i}`} className="workflow-task">
              <span className={`workflow-task__status workflow-task__status--${ns.status}`}>
                {ns.status === 'running' ? (
                  <Loader2 size={10} className="workflow-tasks__spinner" />
                ) : ns.status === 'error' ? (
                  <AlertCircle size={10} />
                ) : (
                  <Check size={10} />
                )}
              </span>
              <span className="workflow-task__name">{ns.nodeId}</span>
              <span className="workflow-task__duration">
                {formatDuration(ns.startedAt, ns.endedAt)}
              </span>
              {ns.error ? (
                <span className="workflow-task__error" title={ns.error}>{ns.error}</span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
