import { useEffect, useState } from 'react'
import { HashRouter } from 'react-router-dom'
import { AppRoutes } from '@renderer/routes/index'
import { useThemeStore } from '@renderer/store/theme'
import { isIpcFailure, type SystemPingResponse } from '@shared/types'

export default function App() {
  const loadTheme = useThemeStore((state) => state.load)
  const subscribeSystemMode = useThemeStore(
    (state) => state.subscribeSystemMode,
  )
  const isLoaded = useThemeStore((state) => state.isLoaded)
  const [status, setStatus] = useState<string>('连接桌面壳...')

  useEffect(() => {
    void loadTheme()
    // 跟随系统明暗变化（mode='system' 时由 store 内 matchMedia 监听重应用 DOM）
    const unsub = subscribeSystemMode()
    void window.one.system.ping().then((result) => {
      if (isIpcFailure(result)) {
        setStatus(`连接失败：${result.message}`)
        return
      }
      const response: SystemPingResponse = result.data
      document.documentElement.dataset.platform = response.platform
      setStatus(`已连接 ${response.platform} / v${response.appVersion}`)
    })
    return () => unsub()
  }, [loadTheme, subscribeSystemMode])

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
