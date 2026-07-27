import { useTranslation } from 'react-i18next'
import { useThemeStore } from '@renderer/store/theme'
import { DEFAULT_THEME } from '@shared/types'

const PRESETS = [
  { value: 'pure-white', key: 'pureWhite' },
  { value: 'warm', key: 'warm' },
  { value: 'dark', key: 'dark' },
] as const

export function SettingsPage() {
  const { t } = useTranslation(['settings', 'common'])
  const theme = useThemeStore((state) => state.theme)
  const saveTheme = useThemeStore((state) => state.save)

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', display: 'grid', gap: 20 }}>
      <section className="glass-panel" style={{ borderRadius: 24, padding: 20 }}>
        <h2 className="section-title" style={{ fontSize: '1rem' }}>
          {t('settings:appearance.title')}
        </h2>
        <p className="section-subtitle">{t('settings:appearance.subtitle')}</p>
      </section>

      <section className="placeholder-grid">
        {PRESETS.map((preset) => (
          <button
            key={preset.value}
            type="button"
            className="surface-panel placeholder-card"
            onClick={() => {
              void saveTheme({
                ...theme,
                preset: preset.value,
                mode: preset.value === 'dark' ? 'dark' : 'light',
              })
            }}
            style={{
              borderRadius: 20,
              textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            <h3 className="section-title">
              {t(`settings:appearance.presets.${preset.key}`)}
            </h3>
            <p className="section-subtitle">{t('settings:appearance.presetHint')}</p>
          </button>
        ))}
      </section>

      <button
        type="button"
        onClick={() => {
          void saveTheme(DEFAULT_THEME)
        }}
        style={{
          justifySelf: 'start',
          border: 0,
          borderRadius: 999,
          background: 'var(--color-bg-3)',
          color: 'var(--color-fg-1)',
          padding: '10px 16px',
          cursor: 'pointer',
        }}
      >
        {t('common:actions.reset')}
      </button>
    </div>
  )
}
