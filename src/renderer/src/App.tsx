import { useEffect, useState } from 'react'
import { HashRouter } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AppRoutes } from '@renderer/routes/index'
import { useThemeStore } from '@renderer/store/theme'
import { isIpcFailure, type SystemPingResponse } from '@shared/types'

export default function App() {
  const { t } = useTranslation(['common'])
  const loadTheme = useThemeStore((state) => state.load)
  const subscribeSystemMode = useThemeStore(
    (state) => state.subscribeSystemMode,
  )
  const isLoaded = useThemeStore((state) => state.isLoaded)
  const [status, setStatus] = useState<string>(t('common:status.connecting'))

  useEffect(() => {
    void loadTheme()
    const unsub = subscribeSystemMode()
    void window.one.system.ping().then((result) => {
      if (isIpcFailure(result)) {
        setStatus(t('common:status.failed', { message: result.message }))
        return
      }
      const response: SystemPingResponse = result.data
      document.documentElement.dataset.platform = response.platform
      setStatus(
        t('common:status.connected', {
          platform: response.platform,
          version: response.appVersion,
        }),
      )
    })
    return () => unsub()
  }, [loadTheme, subscribeSystemMode, t])

  if (!isLoaded) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: 'var(--color-bg-0)',
          color: 'var(--color-fg-1)',
        }}
      >
        {status}
      </div>
    )
  }

  return (
    <HashRouter>
      <AppRoutes />
    </HashRouter>
  )
}
