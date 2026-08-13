import { useState } from 'react'
import { ShieldCheck, ShieldX, Terminal, Clock, Infinity as InfinityIcon, ChevronDown, ChevronUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { unwrap } from '@renderer/api/client'
import type { ApprovalPrompt } from './types'

// —— HITL 工具审批卡（approvalMode='always' → approval_request 事件渲染）——
// pending：展示工具名 + 可折叠入参；用户可选「允许 / 本会话允许 / 拒绝」；
// approved / denied / expired：定格只读 + 淡入动画。应答走 orchestrate:respond（同一应答队列）。
// approved_session → 主进程写入会话放行表，后续同 session 同工具不再弹窗。

type ApprovalResponse = 'approved' | 'approved_session' | 'denied'

export function ApprovalCard({
  prompt,
}: {
  prompt: ApprovalPrompt
}) {
  const { t } = useTranslation(['common'])
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [argsExpanded, setArgsExpanded] = useState(false)

  const respond = async (response: ApprovalResponse): Promise<void> => {
    if (submitting || prompt.status !== 'pending') return
    setSubmitting(true)
    setSubmitError(null)
    try {
      await window.one.orchestrate
        .respond({ requestId: prompt.requestId, response })
        .then(unwrap)
      // 定格由 approval_resolved 事件驱动（reducer），这里无需本地改状态
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  // 格式化入参展示（JSON 美化，限制长度）
  const argsDisplay = (() => {
    try {
      const json = JSON.stringify(prompt.args, null, 2)
      return json.length > 2000 ? json.slice(0, 2000) + '\n...' : json
    } catch {
      return String(prompt.args)
    }
  })()

  // 入参摘要（折叠时显示）
  const argsSummary = (() => {
    try {
      const json = JSON.stringify(prompt.args)
      if (!json || json === '{}') return t('common:tool.args')
      return json.length > 60 ? json.slice(0, 60) + '…' : json
    } catch {
      return ''
    }
  })()

  return (
    <div className={`approval-card approval-card--${prompt.status}`}>
      <div className="approval-card__header">
        <Terminal size={14} />
        <span>{t('common:approval.title', { tool: prompt.toolName })}</span>
      </div>
      <p className="approval-card__warning">{t('common:approval.warning')}</p>

      {/* 可折叠入参 */}
      <button
        type="button"
        className="approval-card__args-toggle"
        onClick={() => setArgsExpanded((v) => !v)}
        aria-expanded={argsExpanded}
      >
        {argsExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        <span className="approval-card__args-summary">{argsSummary}</span>
      </button>
      {argsExpanded ? (
        <div className="approval-card__args">
          <code>{argsDisplay}</code>
        </div>
      ) : null}

      {prompt.status === 'pending' ? (
        <div className="approval-card__actions">
          <button
            type="button"
            className="approval-card__btn approval-card__btn--approve"
            disabled={submitting}
            onClick={() => void respond('approved')}
          >
            <ShieldCheck size={14} /> {t('common:approval.approve')}
          </button>
          <button
            type="button"
            className="approval-card__btn approval-card__btn--session"
            disabled={submitting}
            onClick={() => void respond('approved_session')}
          >
            <InfinityIcon size={14} /> {t('common:approval.approveSession')}
          </button>
          <button
            type="button"
            className="approval-card__btn approval-card__btn--deny"
            disabled={submitting}
            onClick={() => void respond('denied')}
          >
            <ShieldX size={14} /> {t('common:approval.deny')}
          </button>
        </div>
      ) : prompt.status === 'approved' ? (
        <div className="approval-card__resolved approval-card__resolved--approved">
          <ShieldCheck size={14} />{' '}
          {prompt.sessionWide
            ? t('common:approval.approvedSession')
            : t('common:approval.approved')}
        </div>
      ) : prompt.status === 'denied' ? (
        <div className="approval-card__resolved approval-card__resolved--denied">
          <ShieldX size={14} /> {t('common:approval.denied')}
        </div>
      ) : (
        <div className="approval-card__resolved approval-card__resolved--expired">
          <Clock size={14} /> {t('common:approval.expired')}
        </div>
      )}

      {submitError ? (
        <p className="approval-card__error">
          {t('common:approval.failed', { message: submitError })}
        </p>
      ) : null}
    </div>
  )
}
