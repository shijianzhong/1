// —— OKLCH 色彩派生（DESIGN §12.5）——
// 用户只给主色 hex（accent），在 OKLCH 色空间派生 300/400/600 三档：
//   brand-300：L 提亮 12%（hover/渐变）
//   brand-400：L 提亮 6%（次操作）
//   brand-500：主色本身
//   brand-600：L 压暗 6%（按下/聚焦）
// OKLCH 的 L 是感知亮度，等量加减后色相不漂移（RGB 位移会让薄荷绿发灰发浊）。

// —— sRGB → 线性 sRGB → LMS → OKLab → OKLCH ——
// 参考 https://bottosson.github.io/posts/oklab/
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

function clampByte(c: number): number {
  return Math.round(Math.min(1, Math.max(0, c)) * 255)
}

export type Oklch = [number, number, number] // L, C, H

export function hexToOklch(hex: string): Oklch {
  const normalized = hex.replace('#', '')
  const value =
    normalized.length === 3
      ? normalized
          .split('')
          .map((c) => c + c)
          .join('')
      : normalized
  const num = Number.parseInt(value, 16)
  const r = srgbToLinear(((num >> 16) & 255) / 255)
  const g = srgbToLinear(((num >> 8) & 255) / 255)
  const b = srgbToLinear((num & 255) / 255)

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b

  const l_ = Math.cbrt(l)
  const m_ = Math.cbrt(m)
  const s_ = Math.cbrt(s)

  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_
  const a = 1.9779984951 * l_ - 2.428593205 * m_ + 0.4505937099 * s_
  const bLab = 0.0259040371 * l_ + 0.7827717663 * m_ - 0.808675766 * s_

  const C = Math.sqrt(a * a + bLab * bLab)
  const H = (Math.atan2(bLab, a) * 180) / Math.PI
  return [L, C, H >= 0 ? H : H + 360]
}

export function oklchToHex(L: number, C: number, H: number): string {
  const hRad = (H * Math.PI) / 180
  const a = C * Math.cos(hRad)
  const b = C * Math.sin(hRad)

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b

  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3

  const r = linearToSrgb(
    4.0767416621 * l - 3.3077105913 * m + 0.2309699492 * s,
  )
  const g = linearToSrgb(
    -1.2684380046 * l + 2.6097573491 * m - 0.3413193965 * s,
  )
  const bOut = linearToSrgb(
    -0.0041960863 * l - 0.7034186147 * m + 1.7076146944 * s,
  )

  return (
    '#' +
    [r, g, bOut]
      .map((c) => clampByte(c).toString(16).padStart(2, '0'))
      .join('')
  )
}

/** 派生 brand-300/400/600 三档（DESIGN §12.5：±12%/±6% L） */
export function deriveBrandScale(accent: string): {
  '300': string
  '400': string
  '500': string
  '600': string
} {
  const [L, C, H] = hexToOklch(accent)
  return {
    '300': oklchToHex(Math.min(1, L + 0.12), C, H),
    '400': oklchToHex(Math.min(1, L + 0.06), C, H),
    '500': oklchToHex(L, C, H),
    '600': oklchToHex(Math.max(0, L - 0.06), C, H),
  }
}
