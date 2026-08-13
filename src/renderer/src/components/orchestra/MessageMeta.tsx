import { useState } from 'react'
import { Copy, Check, Clock, Timer, Coins } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface MessageMetaProps {
  text: string
  createdAt?: number
  completedAt?: number
}

/** 粗估 token 数：中英混合 ≈ 3.5 字符/token */
function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 3.5)
}

function formatTime(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(ts)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const min = Math.floor(ms / 60_000)
  const sec = Math.round((ms % 60_000) / 1000)
  return `${min}m${sec}s`
}

/**
 * 消息元信息条：显示在 AI 回复气泡底部，含时间、耗时、token 估算、复制按钮。
 * 仅在非流式、非错误、有文本的 assistant 消息上渲染。
 */
export function MessageMeta({ text, createdAt, completedAt }: MessageMetaProps) {
  const { t } = useTranslation(['common'])
  const [copied, setCopied] = useState(false)

  if (!text.trim()) return null

  const tokens = estimateTokens(text)
  const hasTiming = createdAt && completedAt
  const duration = hasTiming ? completedAt - createdAt : undefined

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="message-meta">
      {createdAt ? (
        <span className="message-meta__item" title={t('common:meta.time')}>
          <Clock size={11} />
          <span>{formatTime(createdAt)}</span>
        </span>
      ) : null}
      {duration !== undefined ? (
        <span className="message-meta__item" title={t('common:meta.duration')}>
          <Timer size={11} />
          <span>{formatDuration(duration)}</span>
        </span>
      ) : null}
      <span className="message-meta__item" title={t('common:meta.tokens')}>
        <Coins size={11} />
        <span>~{tokens}</span>
      </span>
      <button
        type="button"
        className="message-meta__copy"
        onClick={handleCopy}
        title={copied ? t('common:code.copied') : t('common:meta.copy')}
        aria-label={t('common:meta.copy')}
      >
        {copied ? <Check size={11} /> : <Copy size={11} />}
      </button>
    </div>
  )
}
