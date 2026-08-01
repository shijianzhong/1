import { Sparkles } from 'lucide-react'
import { motion } from 'framer-motion'
import { useTranslation } from 'react-i18next'
import { Markdown } from '@renderer/components/Markdown'
import { CreateConfirmCard, type CardStatus } from '@renderer/components/CreateConfirmCard'
import { ThinkingBlock } from './ThinkingBlock'
import { AskUserCard } from './AskUserCard'
import type { ChatMessage } from './types'

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
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={`message ${m.role === 'user' ? 'message--user' : ''}`}
    >
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
          <Markdown>{m.text}</Markdown>
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
    </motion.div>
  )
}
