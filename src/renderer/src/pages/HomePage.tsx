import { Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function HomePage() {
  const { t } = useTranslation(['common', 'home'])

  return (
    <div className="chat-shell">
      <section className="glass-panel placeholder-card" style={{ borderRadius: 28, padding: 24 }}>
        <p className="section-title">{t('home:welcome')}</p>
        <p className="section-subtitle">{t('home:description')}</p>
      </section>

      <div className="message">
        <div className="message__avatar">
          <Sparkles size={16} />
        </div>
        <div className="message__bubble message__bubble--assistant">
          {t('home:assistantPlaceholder')}
        </div>
      </div>

      <div className="message message--user">
        <div className="message__bubble message__bubble--user">
          {t('home:userPlaceholder')}
        </div>
      </div>

      <div className="glass-panel composer">
        <input placeholder={t('home:composerPlaceholder')} />
        <button type="button">{t('common:actions.send')}</button>
      </div>
    </div>
  )
}
