import type { CreateDraft } from '@shared/types'

// —— 聊天创建幻觉检测 + kind 推断（docs/CHAT_CREATE_PERSISTENCE_FIX.md A2/A3 · R1）——
// 纯关键词表，不引入额外 LLM 分类调用。

export type CreateKind = CreateDraft['kind']

const SUCCESS_HALLUCINATION =
  /已入库|正式创建成功|创建成功[！!]|已经帮你建好|已经帮你创建|已配好|已就绪|技能已添加|能力已添加|角色已添加|能力已配好|工作流已就绪|已添加到库/

const DENY_PERSISTENCE =
  /没有实际的.{0,12}存储|没有.{0,12}持久化|只是模拟|无法.{0,16}保存到系统|对话环境中没有/

/**
 * 主 Agent 自称已完成创建 / 否认持久化，且本回合未 propose 时需要强制补跑。
 * 「请在下方确认入库」等正当引导不触发。
 */
export function needsCreateRecovery(assistantText: string): boolean {
  const text = assistantText.trim()
  if (!text) return false
  const hallu = SUCCESS_HALLUCINATION.test(text) || DENY_PERSISTENCE.test(text)
  if (!hallu) return false
  // 仅正当引导、同时不含成功/否认词 → 已在上面 hallu=false；若误伤「确认入库」：
  if (/请在下方.*确认|预览已生成|待你确认/.test(text) && !DENY_PERSISTENCE.test(text) && !/已入库|正式创建|创建成功[！!]|已经帮你|已配好|已就绪|已添加/.test(text)) {
    return false
  }
  return true
}

/** 从一段文本推断创建资产 kind；无命中返回 null */
export function inferCreateKindFromText(text: string): CreateKind | null {
  const t = text.toLowerCase()
  // 人设优先（「叫我」「语种」易与角色混淆）
  if (/人设|叫我|偏好语种|preferredlanguage|persona/.test(t) || /用(?:中文|英文)回复/.test(text)) {
    return 'persona'
  }
  if (/技能|skill\.md|skill\b|skill_/.test(t) || /skill\.md/i.test(text)) {
    return 'skill'
  }
  if (/能力|编排|工作流|workflow|capability|画布/.test(t)) {
    return 'capability'
  }
  if (/工具|插件|generated/.test(t)) {
    return 'generated'
  }
  if (/角色|\bagent\b|助手人设/.test(t)) {
    // 「助手人设」已在 persona；纯「角色/agent」
    return 'agent'
  }
  if (/助手/.test(text) && /创建|打造|新建|修改/.test(text)) {
    return 'agent'
  }
  return null
}

/**
 * kind 推断（R1）：
 * 1. 优先用户最近一条消息
 * 2. 否则扫助手正文
 * 3. 都无命中 → null（调用方挂四类工具兜底）
 */
export function inferCreateKind(userMessage: string, assistantText: string): CreateKind | null {
  return inferCreateKindFromText(userMessage) ?? inferCreateKindFromText(assistantText)
}

/** propose_* 工具名 → kind */
export function createKindFromToolName(toolName: string): CreateKind | null {
  switch (toolName) {
    case 'propose_agent':
      return 'agent'
    case 'propose_capability':
      return 'capability'
    case 'propose_skill':
      return 'skill'
    case 'propose_persona':
      return 'persona'
    case 'propose_generated':
      return 'generated'
    default:
      return null
  }
}

export function proposeToolNameForKind(kind: CreateKind): string {
  return `propose_${kind}`
}
