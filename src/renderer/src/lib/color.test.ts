import { describe, expect, it } from 'vitest'
import { deriveBrandScale, hexToOklch, oklchToHex } from './color'

describe('OKLCH 色彩派生（DESIGN §12.5）', () => {
  it('hex → oklch → hex 接近原色（round-trip）', () => {
    const hex = '#4ECDC4'
    const [L, C, H] = hexToOklch(hex)
    const back = oklchToHex(L, C, H)
    // 转 sRGB 8bit 有量化误差，各通道容差 1
    expect(back.toLowerCase()).toBe(hex.toLowerCase())
  })

  it('派生档位亮度单调：300 > 400 > 500 > 600', () => {
    const scale = deriveBrandScale('#4ECDC4')
    const L300 = hexToOklch(scale['300'])[0]
    const L400 = hexToOklch(scale['400'])[0]
    const L500 = hexToOklch(scale['500'])[0]
    const L600 = hexToOklch(scale['600'])[0]
    expect(L300).toBeGreaterThan(L400)
    expect(L400).toBeGreaterThan(L500)
    expect(L500).toBeGreaterThan(L600)
  })

  it('派生档位色相稳定（H 不漂移）', () => {
    const scale = deriveBrandScale('#4ECDC4')
    const H300 = hexToOklch(scale['300'])[2]
    const H500 = hexToOklch(scale['500'])[2]
    // RGB 位移会色相漂移，OKLCH 派生 H 一致（±1 容差）
    expect(Math.abs(H300 - H500)).toBeLessThan(1)
  })

  it('500 即主色本身', () => {
    const scale = deriveBrandScale('#4ECDC4')
    expect(scale['500'].toLowerCase()).toBe('#4ecdc4')
  })

  it('300 提亮约 12%，600 压暗约 6%', () => {
    const accent = '#4ECDC4'
    const [L] = hexToOklch(accent)
    const scale = deriveBrandScale(accent)
    const [L300] = hexToOklch(scale['300'])
    const [L600] = hexToOklch(scale['600'])
    expect(L300 - L).toBeGreaterThan(0.1)
    expect(L - L600).toBeGreaterThan(0.04)
  })
})
