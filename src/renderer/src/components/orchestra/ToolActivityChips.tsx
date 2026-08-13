import { useState } from 'react'
import { ChevronDown, ChevronUp, Check, Loader2, AlertCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ToolCallInfo } from './types'

/**
 * 工具调用活动芯片：在 AI 回复中展示 agent 调了什么工具、传了什么参数、返回了什么结果。
 *
 * 默认折叠显示 "N tool calls" 摘要头，展开后逐行显示工具芯片。
 * 每个芯片可单独展开查看完整入参/返回值摘要。
 */
export function ToolActivityChips({ toolCalls }: { toolCalls: ToolCallInfo[] }) {
  const { t } = useTranslation(['common'])
  const [expanded, setExpanded] = useState(false)
  const [expandedToolId, setExpandedToolId] = useState<string | null>(null)

  if (!toolCalls.length) return null

  const pendingCount = toolCalls.filter((tc) => tc.status === 'pending').length
  const hasError = toolCalls.some((tc) => tc.status === 'error')

  return (
    <div className="tool-chips">
      <button
        type="button"
        className="tool-chips__header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="tool-chips__icon">
          {pendingCount > 0 ? (
            <Loader2 size={12} className="tool-chips__spinner" />
          ) : hasError ? (
            <AlertCircle size={12} />
          ) : (
            <Check size={12} />
          )}
        </span>
        <span className="tool-chips__label">
          {toolCalls.length} {t('common:tool.calls')}
          {pendingCount > 0 ? ` · ${pendingCount} ${t('common:tool.pending')}` : ''}
        </span>
        {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>

      {expanded ? (
        <div className="tool-chips__list">
          {toolCalls.map((tc) => (
            <div key={tc.id} className="tool-chip">
              <button
                type="button"
                className="tool-chip__row"
                onClick={() => setExpandedToolId((id) => (id === tc.id ? null : tc.id))}
                aria-expanded={expandedToolId === tc.id}
              >
                <span className={`tool-chip__status tool-chip__status--${tc.status}`}>
                  {tc.status === 'pending' ? (
                    <Loader2 size={10} className="tool-chips__spinner" />
                  ) : tc.status === 'error' ? (
                    <AlertCircle size={10} />
                  ) : (
                    <Check size={10} />
                  )}
                </span>
                <span className="tool-chip__name">{tc.tool}</span>
                {tc.argsSummary ? (
                  <span className="tool-chip__args">{tc.argsSummary}</span>
                ) : null}
              </button>
              {expandedToolId === tc.id ? (
                <div className="tool-chip__detail">
                  {tc.argsSummary ? (
                    <div className="tool-chip__detail-row">
                      <span className="tool-chip__detail-label">{t('common:tool.args')}</span>
                      <code className="tool-chip__detail-code">{tc.argsSummary}</code>
                    </div>
                  ) : null}
                  {tc.resultSummary ? (
                    <div className="tool-chip__detail-row">
                      <span className="tool-chip__detail-label">{t('common:tool.result')}</span>
                      <code className="tool-chip__detail-code">{tc.resultSummary}</code>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
