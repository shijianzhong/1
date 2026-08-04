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

/** 异步加载背景图并补到 DOM（不阻塞首屏） */
function applyBackgroundAsync(theme: ThemeConfig): void {
  if (theme.background?.type !== 'image' || !theme.background.imageId) return
  void fetchBgDataUrl(theme).then((dataUrls) => {
    if (Object.keys(dataUrls).length > 0) {
      applyThemeToDom(theme, dataUrls)
    }
  })
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
    // 先不等待背景图，立即应用主题进首屏
    applyThemeToDom(theme)
    writeThemeCache(theme)
    set({ theme, isLoaded: true })
    // 背景图异步后补，不阻塞应用渲染
    applyBackgroundAsync(theme)
  },
  save: async (theme) => {
    const result = await window.one.theme.set(theme)
    const nextTheme = unwrap(result, { ...DEFAULT_THEME, ...theme })
    // save 时用户在设置页操作，背景图同步加载（即时反馈）
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
    systemModeUnsub = () => {
      mql.removeEventListener('change', onChange)
      // 复位句柄：否则 cleanup 后再次订阅（HMR 重挂载）会拿到已失效的旧
      // cleanup 直接返回，系统主题监听永久丢失
      systemModeUnsub = null
    }
    return systemModeUnsub
  },
}))
