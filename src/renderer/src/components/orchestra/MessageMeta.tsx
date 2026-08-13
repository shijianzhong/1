import { useState } from 'react'
import { Copy, Check, Clock, Timer, Coins } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TokenUsage } from '@shared/types'

interface MessageMetaProps {
  text: string
  createdAt?: number
  completedAt?: number
  /** 后端 message_stop 携带的真实 token 用量；为空时回退到字符估算 */
  tokenUsage?: TokenUsage
}

/** 粗估 token 数：中英混合 ≈ 3.5 字符/token（后端不传 usage 时回退） */
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
 * 消息元信息条：显示在 AI 回复气泡底部，含时间、耗时、token 用量、复制按钮。
 * 仅在非流式、非错误、有文本的 assistant 消息上渲染。
 *
 * token 用量优先读后端 usage（message_stop delta），后端不传则字符估算。
 */
export function MessageMeta({ text, createdAt, completedAt, tokenUsage }: MessageMetaProps) {
  const { t } = useTranslation(['common'])
  const [copied, setCopied] = useState(false)

  if (!text.trim()) return null

  const hasTiming = createdAt && completedAt
  const duration = hasTiming ? completedAt - createdAt : undefined

  // token 显示：后端有 usage → 显示 outputTokens（或 totalTokens）；
  // 后端没传 → 字符估算，前缀 ~ 表示估值
  const isEstimated = !tokenUsage
  const tokenCount = tokenUsage?.outputTokens ?? tokenUsage?.totalTokens ?? estimateTokens(text)
  const tokenLabel = isEstimated ? `~${tokenCount}` : String(tokenCount)

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
          <Clock size={12} />
          <span>{formatTime(createdAt)}</span>
        </span>
      ) : null}
      {duration !== undefined ? (
        <span className="message-meta__item" title={t('common:meta.duration')}>
          <Timer size={12} />
          <span className="message-meta__label">{t('common:meta.durationLabel')}</span>
          <span>{formatDuration(duration)}</span>
        </span>
      ) : null}
      <span
        className="message-meta__item"
        title={isEstimated ? t('common:meta.tokensEstimate') : t('common:meta.tokens')}
      >
        <Coins size={12} />
        <span className="message-meta__label">{t('common:meta.tokensLabel')}</span>
        <span>{tokenLabel}</span>
      </span>
      <button
        type="button"
        className="message-meta__copy"
        onClick={handleCopy}
        title={copied ? t('common:code.copied') : t('common:meta.copy')}
        aria-label={t('common:meta.copy')}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
        <span className="message-meta__label">{copied ? t('common:code.copied') : t('common:meta.copy')}</span>
      </button>
    </div>
  )
}
