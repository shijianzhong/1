import type { Persona } from '@shared/types'

// —— L0 实时上下文（§三之三 D + 铁律21）——
// 拼进 instructions 开头（不挂 token 计数）。
// 单用户桌面版无鉴权：从本地用户档案（设置页"个人档案"）取，无则留空。

/**
 * 构建用户身份块。
 * @param persona 首页主助手人设（含 profile：alias/role/preferredLanguage）
 * @returns 身份段文本，无档案返回空串
 */
export function buildUserIdentityBlock(persona: Persona | null): string {
  const profile = persona?.profile
  if (!profile) return ''

  const lines: string[] = []
  if (profile.alias) lines.push(`称呼：${profile.alias}`)
  if (profile.role) lines.push(`角色：${profile.role}`)
  if (profile.preferredLanguage) {
    const langLabel =
      profile.preferredLanguage === 'zh-CN' ? '中文' : 'English'
    lines.push(`偏好回复语种：${langLabel}`)
  }

  if (lines.length === 0) return ''
  return `【用户档案】\n${lines.join('\n')}`
}

/**
 * 将身份块拼到 instructions 开头（§D 拼装顺序第 1 步）。
 * 身份块在前，后接 instructions 正文。
 */
export function injectL0(instructions: string, persona: Persona | null): string {
  const block = buildUserIdentityBlock(persona)
  if (!block) return instructions
  return `${block}\n\n${instructions}`
}
