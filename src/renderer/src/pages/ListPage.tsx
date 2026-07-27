import { useTranslation } from 'react-i18next'

interface ListPageProps {
  /** i18n key 前缀，如 'agents' → 解析 common:list.agents.title / .description */
  i18nKey: string
}

export function ListPage({ i18nKey }: ListPageProps) {
  const { t } = useTranslation(['common'])
  const title = t(`common:list.${i18nKey}.title`)
  const description = t(`common:list.${i18nKey}.description`)

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <section
        className="glass-panel"
        style={{ padding: 16, borderRadius: 24, display: 'flex', justifyContent: 'space-between' }}
      >
        <div>
          <h2 className="section-title" style={{ fontSize: '1rem' }}>
            {title}
          </h2>
          <p className="section-subtitle">{description}</p>
        </div>
        <button
          type="button"
          style={{
            border: 0,
            borderRadius: 999,
            background: 'var(--color-brand-500)',
            color: 'white',
            padding: '10px 16px',
            cursor: 'pointer',
          }}
        >
          {t('common:actions.new')}
        </button>
      </section>

      <section className="placeholder-grid">
        {Array.from({ length: 6 }).map((_, index) => (
          <article
            key={index}
            className="surface-panel placeholder-card"
            style={{ borderRadius: 20 }}
          >
            <h3 className="section-title">
              {title} #{index + 1}
            </h3>
            <p className="section-subtitle">{description}</p>
          </article>
        ))}
      </section>
    </div>
  )
}
