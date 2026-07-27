// —— 防首屏闪白（§11/§十二）：React 挂载前同步应用上次缓存的明暗 + 点缀色 ——
// theme 存主进程 userData，首屏无法同步 IPC 读；故渲染层在 store load 成功后
// 把 { isDark, accent } 缓存到 localStorage，下次启动本模块同步读取应用，
// 避免"先白后暗"或"先默认色后点缀色"的闪白。
import { DEFAULT_THEME, type ThemeConfig } from '@shared/types'
import { deriveBrandScale } from './lib/color'

const CACHE_KEY = 'one:theme-cache'

interface ThemeCache {
  isDark: boolean
  accent?: string | null
}

function readCache(): ThemeCache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as ThemeCache
  } catch {
    return null
  }
}

function resolveSystemDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches
  )
}

export function bootstrapTheme(): void {
  const cache = readCache()
  const isDark =
    cache?.isDark ?? resolveSystemDark()
  const accent = cache?.accent ?? DEFAULT_THEME.accent ?? '#4ECDC4'

  const root = document.documentElement
  root.classList.toggle('dark', isDark)

  const brand = deriveBrandScale(accent)
  root.style.setProperty('--color-brand-300', brand['300'])
  root.style.setProperty('--color-brand-400', brand['400'])
  root.style.setProperty('--color-brand-500', brand['500'])
  root.style.setProperty('--color-brand-600', brand['600'])
}

export function writeThemeCache(theme: ThemeConfig): void {
  const isDark =
    theme.mode === 'dark' ||
    (theme.mode === 'system' && resolveSystemDark())
  const cache: ThemeCache = { isDark, accent: theme.accent }
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    // 忽略隐私模式等写入失败
  }
}
