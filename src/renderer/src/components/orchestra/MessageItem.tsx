import { lazy, Suspense } from 'react'
import { Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CreateConfirmCard, type CardStatus } from '@renderer/components/CreateConfirmCard'
import { ThinkingOrb } from '@renderer/components/ThinkingOrb'
import { ThinkingBlock } from './ThinkingBlock'
import { AskUserCard } from './AskUserCard'
import type { ChatMessage } from './types'

// react-markdown + remark/rehype + katex 合计约 1.2MB，不放进冷启动首包：
// 首条 assistant 消息挂载时按需加载，fallback 先以纯文本呈现（可读），chunk 到位后升级为富渲染。
const Markdown = lazy(() =>
  import('@renderer/components/Markdown').then((m) => ({ default: m.Markdown })),
)

// —— 单条聊天消息气泡（HomePage 与 EditorPage 运行面板共用）——
// 覆盖：user/assistant 气泡、thinking 折叠、speaker 头、Markdown、流式光标、
// 重试态、错误重试按钮、创建确认卡（draft）、HITL 提问卡（askUser）。

export function MessageItem({
  msg,
  speakerName,
  onRetryError,
  onDraftStatusChange,
}: {
  msg: ChatMessage
  speakerName: (id: string) => string
  /** 错误气泡的重试回调（不传则错误气泡无重试按钮） */
  onRetryError?: (msg: ChatMessage) => void
  /** 创建确认卡状态变化（仅首页主助手有 draft 场景） */
  onDraftStatusChange?: (msg: ChatMessage, status: CardStatus) => void
}) {
  const { t } = useTranslation(['common'])
  const m = msg
  return (
    // 入场动效用 CSS（.message 上的 message-enter keyframes）：framer-motion 全项目仅此一处
    // 用法，为 0.2s 淡入拖 270KB 进首包不值当
    <div className={`message ${m.role === 'user' ? 'message--user' : ''}`}>

      {m.role === 'assistant' ? (
        <div className="message__avatar">
          {m.streaming || m.retrying ? (
            <ThinkingOrb state={m.orbState ?? 'working'} size={64} theme="auto" style={{ width: 28, height: 28 }} />
          ) : (
            <Sparkles size={16} />
          )}
        </div>
      ) : null}
      <div
        className={`message__bubble message__bubble--${m.role}`}
        style={m.error ? { color: 'var(--color-danger)', borderColor: 'var(--color-danger)' } : undefined}
      >
        {m.thinking ? <ThinkingBlock text={m.thinking} collapsed={m.thinkingCollapsed} /> : null}
        {m.speaker ? <div className="message__speaker">{speakerName(m.speaker)}</div> : null}
        {m.draft ? (
          <CreateConfirmCard
            draft={m.draft}
            status={m.cardStatus ?? 'pending'}
            onStatusChange={(status) => onDraftStatusChange?.(m, status)}
          />
        ) : m.askUser ? (
          <AskUserCard prompt={m.askUser} speakerName={speakerName} />
        ) : m.retrying ? (
          <span style={{ color: 'var(--color-fg-2)', fontSize: '0.85rem' }}>{m.retrying}</span>
        ) : m.role === 'assistant' ? (
          <Suspense fallback={<span style={{ whiteSpace: 'pre-wrap' }}>{m.text}</span>}>
            <Markdown>{m.text}</Markdown>
          </Suspense>
        ) : (
          m.text
        )}
        {m.streaming ? <span className="stream-cursor">▋</span> : null}
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
