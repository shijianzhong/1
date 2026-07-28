import { create } from 'zustand'
import {
  DEFAULT_THEME,
  isIpcFailure,
  type IpcResult,
  type ThemeConfig,
} from '@shared/types'
import { applyThemeToDom } from '@renderer/lib/theme'
import { writeThemeCache } from '@renderer/bootstrap-theme'

// —— IPC 返回是 IpcResult<T>（withHandler 包过），统一解包；失败回退默认 ——
function unwrap<T>(result: IpcResult<T>, fallback: T): T {
  if (isIpcFailure(result)) {
    // eslint-disable-next-line no-console
    console.error(`[theme] ipc 失败 ${result.code}: ${result.message}`)
    return fallback
  }
  return result.data
}

/** 预取背景图 dataUrl（applyThemeToDom 用） */
async function fetchBgDataUrl(theme: ThemeConfig): Promise<Record<string, string>> {
  const map: Record<string, string> = {}
  if (theme.background?.type === 'image' && theme.background.imageId) {
    try {
      const result = await window.one.theme.loadBackground(theme.background)
      if (!isIpcFailure(result) && result.data.dataUrl) {
        map[theme.background.imageId] = result.data.dataUrl
      }
    } catch {
      // 静默
    }
  }
  return map
}

interface ThemeState {
  theme: ThemeConfig
  isLoaded: boolean
  load: () => Promise<void>
  save: (theme: ThemeConfig) => Promise<void>
  subscribeSystemMode: () => () => void
}

let systemModeUnsub: (() => void) | null = null

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: DEFAULT_THEME,
  isLoaded: false,
  load: async () => {
    const result = await window.one.theme.get()
    const theme = unwrap(result, DEFAULT_THEME)
    const dataUrls = await fetchBgDataUrl(theme)
    applyThemeToDom(theme, dataUrls)
    writeThemeCache(theme)
    set({ theme, isLoaded: true })
  },
  save: async (theme) => {
    const result = await window.one.theme.set(theme)
    const nextTheme = unwrap(result, { ...DEFAULT_THEME, ...theme })
    const dataUrls = await fetchBgDataUrl(nextTheme)
    applyThemeToDom(nextTheme, dataUrls)
    writeThemeCache(nextTheme)
    set({ theme: nextTheme, isLoaded: true })
  },
  subscribeSystemMode: () => {
    if (systemModeUnsub) return systemModeUnsub
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => {
      const { theme } = get()
      if (theme.mode === 'system') {
        applyThemeToDom(theme)
        writeThemeCache(theme)
      }
    }
    mql.addEventListener('change', onChange)
    systemModeUnsub = () => mql.removeEventListener('change', onChange)
    return systemModeUnsub
  },
}))
