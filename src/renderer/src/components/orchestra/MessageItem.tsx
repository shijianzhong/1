import { lazy, Suspense } from 'react'
import { Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CreateConfirmCard, type CardStatus } from '@renderer/components/CreateConfirmCard'
import { CreateProposalErrorCard } from '@renderer/components/CreateProposalErrorCard'
import { CreateNoticeBar } from '@renderer/components/CreateNoticeBar'
import { ThinkingOrb, type OrbState } from '@renderer/components/ThinkingOrb'
import { ThinkingBlock } from './ThinkingBlock'
import { AskUserCard } from './AskUserCard'
import { ApprovalCard } from './ApprovalCard'
import type { ChatMessage } from './types'

// react-markdown + remark/rehype + katex 合计约 1.2MB，不放进冷启动首包：
// 首条 assistant 消息挂载时按需加载，fallback 先以纯文本呈现（可读），chunk 到位后升级为富渲染。
const Markdown = lazy(() =>
  import('@renderer/components/Markdown').then((m) => ({ default: m.Markdown })),
)

// —— orb 状态 → i18n 标签 key（用于阶段 1 的状态文字）——
const ORB_LABEL_KEY: Record<OrbState, string> = {
  working: 'common:orb.working',
  searching: 'common:orb.searching',
  solving: 'common:orb.solving',
  listening: 'common:orb.listening',
  connecting: 'common:orb.connecting',
  weaving: 'common:orb.weaving',
  composing: 'common:orb.composing',
  breathing: 'common:orb.breathing',
  shaping: 'common:orb.shaping',
}

// —— 单条聊天消息气泡（HomePage 与 EditorPage 运行面板共用）——
// 覆盖：user/assistant 气泡、thinking 折叠、speaker 头、Markdown、
// ThinkingOrb 双阶段（64px 思考头 → 20px 行内光标）、重试态、错误重试按钮、
// 创建确认卡（draft）、HITL 提问卡（askUser）。

export function MessageItem({
  msg,
  speakerName,
  onRetryError,
  onDraftStatusChange,
  onRetryProposalError,
}: {
  msg: ChatMessage
  speakerName: (id: string) => string
  /** 错误气泡的重试回调（不传则错误气泡无重试按钮） */
  onRetryError?: (msg: ChatMessage) => void
  /** 创建确认卡状态变化（仅首页主助手有 draft 场景） */
  onDraftStatusChange?: (msg: ChatMessage, status: CardStatus) => void
  /** propose_* 失败卡「让助手重试」 */
  onRetryProposalError?: (msg: ChatMessage) => void
}) {
  const { t } = useTranslation(['common'])
  const m = msg

  // —— ThinkingOrb 双阶段逻辑 ——
  // 阶段 1（空文本 + streaming/retrying）：64px orb + 状态文字居中显示在气泡顶部
  // 阶段 2（有文本 + streaming）：20px 行内 orb 替代 ▋ 闪烁光标
  const isActive = m.streaming || m.retrying
  const orbState = m.orbState ?? 'working'
  const showOrbHeader =
    isActive && !m.text && !m.draft && !m.askUser && !m.approval && !m.proposalError && !m.createNotice
  const showInlineOrb =
    m.streaming && !!m.text && !m.draft && !m.askUser && !m.approval && !m.proposalError && !m.createNotice

  return (
    // 入场动效用 CSS（.message 上的 message-enter keyframes）：framer-motion 全项目仅此一处
    // 用法，为 0.2s 淡入拖 270KB 进首包不值当
    <div className={`message ${m.role === 'user' ? 'message--user' : ''}`}>

      {m.role === 'assistant' ? (
        <div className="message__avatar">
          <Sparkles size={16} />
        </div>
      ) : null}
      <div
        className={`message__bubble message__bubble--${m.role}`}
        style={m.error ? { color: 'var(--color-danger)', borderColor: 'var(--color-danger)' } : undefined}
      >
        {m.thinking ? <ThinkingBlock text={m.thinking} collapsed={m.thinkingCollapsed} /> : null}
        {m.speaker ? <div className="message__speaker">{speakerName(m.speaker)}</div> : null}
        {m.createNotice ? (
          <CreateNoticeBar notice={m.createNotice} />
        ) : m.draft ? (
          <CreateConfirmCard
            draft={m.draft}
            status={m.cardStatus ?? 'pending'}
            onStatusChange={(status) => onDraftStatusChange?.(m, status)}
          />
        ) : m.proposalError ? (
          <CreateProposalErrorCard
            error={m.proposalError}
            onRetry={() => onRetryProposalError?.(m)}
          />
        ) : m.askUser ? (
          <AskUserCard prompt={m.askUser} speakerName={speakerName} />
        ) : m.approval ? (
          <ApprovalCard prompt={m.approval} />
        ) : m.retrying && !m.text ? (
          <div className="message__orb-header">
            <ThinkingOrb state={orbState} size={64} theme="auto" />
            <span className="message__orb-label">{m.retrying}</span>
          </div>
        ) : m.role === 'assistant' ? (
          <>
            {showOrbHeader ? (
              <div className="message__orb-header">
                <ThinkingOrb state={orbState} size={64} theme="auto" />
                <span className="message__orb-label">{t(ORB_LABEL_KEY[orbState])}</span>
              </div>
            ) : null}
            <Suspense fallback={<span style={{ whiteSpace: 'pre-wrap' }}>{m.text}</span>}>
              <Markdown>{m.text}</Markdown>
            </Suspense>
            {showInlineOrb ? (
              <ThinkingOrb
                state={orbState}
                size={20}
                theme="auto"
                style={{ display: 'inline-block', verticalAlign: 'text-bottom', marginLeft: 2 }}
              />
            ) : null}
          </>
        ) : (
          m.text
        )}
        {m.error && onRetryError ? (
          <button
            type="button"
            onClick={() => onRetryError(m)}
            style={{
              marginTop: 8,
              border: 0,
              borderRadius: 999,
              background: 'var(--color-brand-500)',
              color: 'var(--color-on-brand)',
              padding: '4px 12px',
              fontSize: '0.8rem',
              cursor: 'pointer',
            }}
          >
            {t('common:actions.retry')}
          </button>
        ) : null}
      </div>
    </div>
  )
}
