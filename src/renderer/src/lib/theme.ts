import { DEFAULT_THEME, type ThemeConfig } from '@shared/types'
import { deriveBrandScale } from './color'

// —— 玻璃配方基底 RGB（按 glassTint）——
function getGlassBase(tint: ThemeConfig['glassTint']): [number, number, number] {
  switch (tint) {
    case 'warm':
      return [255, 252, 248]
    case 'neutral':
      return [255, 255, 255]
    case 'cool':
    default:
      return [255, 255, 255]
  }
}

function getBorderBase(tint: ThemeConfig['glassTint']): [number, number, number] {
  switch (tint) {
    case 'warm':
      return [140, 120, 90]
    case 'neutral':
      return [128, 128, 128]
    case 'cool':
    default:
      return [120, 130, 145]
  }
}

function densityScale(density: ThemeConfig['density']): string {
  switch (density) {
    case 'compact':
      return '0.85'
    case 'spacious':
      return '1.15'
    case 'comfortable':
    default:
      return '1'
  }
}

/**
 * 解析主题 mode（system/light/dark）→ 是否暗色。
 * mode='system' 时跟随系统 prefers-color-scheme（§nativeTheme 跟随）。
 */
export function resolveIsDark(theme: ThemeConfig): boolean {
  if (theme.mode === 'dark') return true
  if (theme.mode === 'light') return false
  // system
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches
  )
}

/**
 * 应用主题到 DOM（DESIGN §12.5）。
 * @param dataUrlByImageId  背景图 imageId → dataUrl 映射（由 store 经 IPC loadBackground 预取后传入）
 */
export function applyThemeToDom(
  theme: ThemeConfig,
  dataUrlByImageId?: Record<string, string>,
): void {
  const nextTheme = { ...DEFAULT_THEME, ...theme }
  const root = document.documentElement
  const accent = nextTheme.accent ?? DEFAULT_THEME.accent ?? '#4ECDC4'
  const opacity = nextTheme.glassOpacity ?? DEFAULT_THEME.glassOpacity ?? 0.6
  const blur = nextTheme.glassBlur ?? DEFAULT_THEME.glassBlur ?? 16
  const [glassR, glassG, glassB] = getGlassBase(nextTheme.glassTint)
  const [borderR, borderG, borderB] = getBorderBase(nextTheme.glassTint)

  // —— 明暗跟随系统 ——
  root.classList.toggle('dark', resolveIsDark(nextTheme))
  root.classList.toggle('warm', nextTheme.preset === 'warm')

  // —— 点缀色 OKLCH 派生（§12.5）——
  const brand = deriveBrandScale(accent)
  root.style.setProperty('--color-brand-300', brand['300'])
  root.style.setProperty('--color-brand-400', brand['400'])
  root.style.setProperty('--color-brand-500', brand['500'])
  root.style.setProperty('--color-brand-600', brand['600'])

  root.style.setProperty(
    '--glass-bg',
    `rgba(${glassR}, ${glassG}, ${glassB}, ${opacity})`,
  )
  root.style.setProperty(
    '--glass-bg-strong',
    `rgba(${glassR}, ${glassG}, ${glassB}, ${Math.min(opacity + 0.18, 0.92)})`,
  )
  root.style.setProperty(
    '--glass-border-bottom',
    `rgba(${borderR}, ${borderG}, ${borderB}, 0.12)`,
  )
  root.style.setProperty('--glass-blur', `${blur}px`)
  root.style.setProperty('--glass-blur-strong', `${blur + 8}px`)
  root.style.setProperty('--density-scale', densityScale(nextTheme.density))
  root.style.setProperty('--font-scale', `${nextTheme.fontScale ?? 1}`)

  if (nextTheme.bgOverride) {
    root.style.setProperty('--color-bg-0', nextTheme.bgOverride)
  }
  if (nextTheme.fgOverride) {
    root.style.setProperty('--color-fg-1', nextTheme.fgOverride)
  }

  // —— 背景图/渐变（§12.6.1）——
  applyBackground(nextTheme, dataUrlByImageId)
}

function applyBackground(
  theme: ThemeConfig,
  dataUrlByImageId?: Record<string, string>,
): void {
  const root = document.documentElement
  const bg = theme.background
  if (!bg || bg.type === 'none') {
    root.style.removeProperty('--bg-image')
    root.style.removeProperty('--bg-blur')
    root.style.removeProperty('--bg-dim')
    return
  }
  if (bg.type === 'gradient') {
    // gradient 直接作 image（用户自定义渐变串未来扩展，暂留位）
    root.style.removeProperty('--bg-image')
    return
  }
  // image
  const url = bg.imageId ? dataUrlByImageId?.[bg.imageId] : undefined
  if (url) {
    root.style.setProperty('--bg-image', `url("${url}")`)
  }
  if (bg.blurPx) {
    root.style.setProperty('--bg-blur', `${bg.blurPx}px`)
  }
  if (bg.dimAmount) {
    root.style.setProperty('--bg-dim', String(bg.dimAmount))
  }
}
