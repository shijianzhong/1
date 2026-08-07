import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { CreateDraft } from '@shared/types'

export interface CreateNoticeInfo {
  messageKey: string
  params?: Record<string, string>
  level?: 'info' | 'warn' | 'error'
}

const MANAGE_PATH: Partial<Record<CreateDraft['kind'] | 'unknown', string>> = {
  agent: '/agents',
  capability: '/capabilities',
  skill: '/skills',
  persona: '/settings',
}

/** 创建链路系统提示（补跑中 / 补跑失败）；messageKey 由主进程下发 */
export function CreateNoticeBar({ notice }: { notice: CreateNoticeInfo }) {
  const { t } = useTranslation(['home'])
  const kind = notice.params?.kind ?? 'unknown'
  const kindLabel =
    kind === 'unknown' ? t('home:create.kind.unknown') : t(`home:create.kind.${kind}`, { defaultValue: kind })
  const text = t(notice.messageKey, { kind: kindLabel, ...notice.params })
  const level = notice.level ?? 'info'
  const managePath = MANAGE_PATH[kind as CreateDraft['kind'] | 'unknown']
  const showManage = notice.messageKey.includes('recovery.failed')

  return (
    <div className={`create-notice create-notice--${level}`} role="status">
      <span className="create-notice__text">{text}</span>
      {showManage ? (
        <span className="create-notice__links">
          {managePath ? (
            <Link to={managePath} className="create-notice__link">
              {t('home:create.recovery.openManage', { kind: kindLabel })}
            </Link>
          ) : (
            <>
              <Link to="/agents" className="create-notice__link">
                {t('home:create.recovery.openManage', { kind: t('home:create.kind.agent') })}
              </Link>
              <Link to="/skills" className="create-notice__link">
                {t('home:create.recovery.openManage', { kind: t('home:create.kind.skill') })}
              </Link>
              <Link to="/capabilities" className="create-notice__link">
                {t('home:create.recovery.openManage', { kind: t('home:create.kind.capability') })}
              </Link>
            </>
          )}
        </span>
      ) : null}
    </div>
  )
}
