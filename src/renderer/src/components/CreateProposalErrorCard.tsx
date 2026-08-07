import { useTranslation } from 'react-i18next'
import type { CreateDraft } from '@shared/types'

/** propose_* 失败卡：展示可读原因 +「让助手重试」（R2） */
export interface ProposalErrorInfo {
  kind: CreateDraft['kind']
  error: string
  messageKey?: string
  detail?: unknown
}

interface Props {
  error: ProposalErrorInfo
  onRetry: () => void
}

export function CreateProposalErrorCard({ error, onRetry }: Props) {
  const { t } = useTranslation(['home', 'errors', 'common'])
  const kindLabel = t(`home:create.kind.${error.kind}`)
  const reason = error.messageKey
    ? t(error.messageKey, { defaultValue: error.error })
    : error.error

  return (
    <div className="create-card create-card--error">
      <div className="create-card__head">
        <span className={`create-card__badge create-card__badge--${error.kind}`}>{kindLabel}</span>
        <span className="create-card__title">{t('home:create.error.title', { kind: kindLabel })}</span>
      </div>
      <div className="create-card__body">
        <p className="create-card__error-text">{reason}</p>
        {error.detail != null ? (
          <pre className="create-card__error-detail">
            {typeof error.detail === 'string' ? error.detail : JSON.stringify(error.detail, null, 2)}
          </pre>
        ) : null}
        <p className="create-card__error-hint">{t('home:create.error.hint')}</p>
      </div>
      <div className="create-card__actions">
        <button type="button" className="create-card__btn create-card__btn--primary" onClick={onRetry}>
          {t('home:create.error.retry')}
        </button>
      </div>
    </div>
  )
}
