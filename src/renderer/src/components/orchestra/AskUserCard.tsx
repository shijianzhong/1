import { useState } from 'react'
import { MessageCircleQuestion, SendHorizontal, SkipForward } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { unwrap } from '@renderer/api/client'
import type { AskUserPrompt } from './types'

// —— HITL 提问卡（ask_user 工具 → request_info 事件渲染）——
// pending：内嵌输入 + 回答/跳过（并发多个 agent 提问时多卡并存、各自作答，不抢 composer）；
// answered / expired：定格只读。应答走 orchestrate:respond（home/编辑器同一应答队列）。

export function AskUserCard({
  prompt,
  speakerName,
}: {
  prompt: AskUserPrompt
  speakerName: (id: string) => string
}) {
  const { t } = useTranslation(['common'])
  const [answer, setAnswer] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const respond = async (response: string): Promise<void> => {
    if (submitting || prompt.status !== 'pending') return
    setSubmitting(true)
    setSubmitError(null)
    try {
      await window.one.orchestrate
        .respond({ requestId: prompt.requestId, response })
        .then(unwrap)
      // 定格由 request_resolved 事件驱动（reducer），这里无需本地改状态
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="ask-user-card">
      <div className="ask-user-card__header">
        <MessageCircleQuestion size={14} />
        <span>{t('common:askUser.title', { name: speakerName(prompt.nodeId) })}</span>
      </div>
      <p className="ask-user-card__question">{prompt.question}</p>
      {prompt.context ? <p className="ask-user-card__context">{prompt.context}</p> : null}

      {prompt.status === 'pending' ? (
        <div className="ask-user-card__form">
          <textarea
            autoFocus
            value={answer}
            disabled={submitting}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (answer.trim()) void respond(answer.trim())
              }
            }}
            placeholder={t('common:askUser.placeholder')}
            rows={2}
          />
          <div className="ask-user-card__actions">
            <button
              type="button"
              className="ask-user-card__btn ask-user-card__btn--ghost"
              disabled={submitting}
              onClick={() => void respond(t('common:askUser.skipResponse'))}
            >
              <SkipForward size={13} /> {t('common:askUser.skip')}
            </button>
            <button
              type="button"
              className="ask-user-card__btn ask-user-card__btn--primary"
              disabled={submitting || !answer.trim()}
              onClick={() => void respond(answer.trim())}
            >
              <SendHorizontal size={13} /> {t('common:askUser.submit')}
            </button>
          </div>
          {submitError ? (
            <p className="ask-user-card__error">
              {t('common:askUser.failed', { message: submitError })}
            </p>
          ) : null}
        </div>
      ) : prompt.status === 'answered' ? (
        <div className="ask-user-card__answer">
          <span className="ask-user-card__answer-label">{t('common:askUser.answered')}</span>
          {prompt.response}
        </div>
      ) : (
        <p className="ask-user-card__expired">{t('common:askUser.expired')}</p>
      )}
    </div>
  )
}
