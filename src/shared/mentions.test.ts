import { describe, expect, it } from 'vitest'
import { formatMentionDisplay, mentionTokensToDisplay } from './mentions'

describe('mentionTokensToDisplay', () => {
  it('把 @[kind:id] 换成 @名字', () => {
    const out = mentionTokensToDisplay(
      '@[capability:cap_x] 用这个跑资讯',
      (kind, id) => (kind === 'capability' && id === 'cap_x' ? '内容生产闭环' : undefined),
    )
    expect(out).toBe('@内容生产闭环 用这个跑资讯')
  })

  it('查不到名字则保留 token', () => {
    expect(mentionTokensToDisplay('@[agent:missing] hi', () => undefined)).toBe(
      '@[agent:missing] hi',
    )
  })

  it('formatMentionDisplay 就是 @名字', () => {
    expect(formatMentionDisplay('代码审查')).toBe('@代码审查')
  })
})
