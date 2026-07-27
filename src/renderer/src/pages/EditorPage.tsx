import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

export function EditorPage() {
  const { t } = useTranslation(['editor'])
  const { capabilityId } = useParams<{ capabilityId?: string }>()
  void capabilityId // M4 接入时用于加载已有能力

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <section
        className="glass-panel"
        style={{
          minHeight: 520,
          borderRadius: 28,
          padding: 24,
          backgroundImage:
            'radial-gradient(circle at 1px 1px, rgba(120,130,145,0.12) 1px, transparent 0)',
          backgroundSize: '20px 20px',
        }}
      >
        <div className="placeholder-grid">
          <article className="glass-panel placeholder-card" style={{ borderRadius: 22 }}>
            <h3 className="section-title">Agent</h3>
            <p className="section-subtitle">{t('editor:nodes.agent')}</p>
          </article>
          <article className="glass-panel placeholder-card" style={{ borderRadius: 22 }}>
            <h3 className="section-title">Sequential</h3>
            <p className="section-subtitle">{t('editor:nodes.sequential')}</p>
          </article>
          <article className="glass-panel placeholder-card" style={{ borderRadius: 22 }}>
            <h3 className="section-title">GroupChat</h3>
            <p className="section-subtitle">{t('editor:nodes.groupchat')}</p>
          </article>
        </div>
      </section>
    </div>
  )
}
