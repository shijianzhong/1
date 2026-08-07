import { useEffect, useRef } from 'react'
import { HashRouter } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AppRoutes } from '@renderer/routes/index'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import { ConfirmHost } from '@renderer/components/ui/ConfirmDialog'
import { CrashRecoveryDialog } from '@renderer/components/CrashRecoveryDialog'
import { useThemeStore } from '@renderer/store/theme'
import { isIpcFailure, type SystemPingResponse } from '@shared/types'
import { startupMark } from '@renderer/lib/startupMark'

let appFirstRenderLogged = false
let enterRoutesLogged = false

export default function App() {
  if (!appFirstRenderLogged) {
    appFirstRenderLogged = true
    startupMark('renderer:App:first-render')
  }
  // 不再用「连接桌面壳 / isLoaded」门控首屏；theme / ping 后台完成
  const { ready } = useTranslation(['common'])
  const loadTheme = useThemeStore((state) => state.load)
  const subscribeSystemMode = useThemeStore((state) => state.subscribeSystemMode)
  const i18nReadyLogged = useRef(false)

  useEffect(() => {
    if (ready && !i18nReadyLogged.current) {
      i18nReadyLogged.current = true
      startupMark('renderer:i18n:common-ready')
    }
  }, [ready])

  useEffect(() => {
    startupMark('renderer:App:mount-effect')
    const themeT0 = performance.now()
    void loadTheme().then(() => {
      startupMark('renderer:theme.load:done', {
        ms: Math.round(performance.now() - themeT0),
      })
    })
    const unsub = subscribeSystemMode()
    const pingT0 = performance.now()
    void window.one.system.ping().then((result) => {
      startupMark('renderer:ping:done', {
        ms: Math.round(performance.now() - pingT0),
        ok: !isIpcFailure(result),
      })
      if (isIpcFailure(result)) return
      const response: SystemPingResponse = result.data
      document.documentElement.dataset.platform = response.platform
      startupMark('renderer:status:connected', {
        platform: response.platform,
        version: response.appVersion,
      })
    })
    return () => unsub()
  }, [loadTheme, subscribeSystemMode])

  if (!enterRoutesLogged) {
    enterRoutesLogged = true
    startupMark('renderer:App:enter-routes')
  }

  return (
    <ErrorBoundary>
      <HashRouter>
        <AppRoutes />
        <ConfirmHost />
        <CrashRecoveryDialog />
      </HashRouter>
    </ErrorBoundary>
  )
}
