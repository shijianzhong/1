import type {
  Agent,
  Capability,
  RegistryAgentManifest,
  RegistryCapabilityManifest,
  RegistrySkillManifest,
  Skill,
  WorkflowGraph,
} from '@shared/types'
import { extractDisciplineSection } from '../skills/upload'

// —— Registry 导出序列化（docs/REGISTRY_PLAN.md §3.3，与 §1 manifest 口径互逆）——
// 纯函数模块：不依赖 electron/存储，可单测。本模块只做「本地实体 → manifest 文本」，
// 级联收集/zip 重组/落盘/provenance 回写在 exporter.ts。

/** 名称 → slug：小写化，非法字符折成连字符；无法产出合法 slug 时返回空串（调用方兜底） */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
}

/** semver patch 自增（更新发布时 CI 要求 version 递增）；非 x.y.z 形式原样返回由用户编辑 */
export function bumpPatch(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())
  if (!m) return version
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
}

/** manifest 通用头（updatedAt 由调用方统一注入，保证同批导出时间一致） */
function baseFields(slug: string, name: string, version: string, updatedAt: string) {
  return { id: slug, name, version, updatedAt }
}

/**
 * Agent → manifest：本地 skillIds 经 slugOf 转 slug（未映射=用户取消勾选/依赖缺失，剔除）；
 * modelId 不可导出，调用方先查 ModelConfig 得真实模型名传入 modelHint；
 * id/source/createdAt/updatedAt(本地) 剥离。
 */
export function serializeAgentManifest(
  agent: Agent,
  ctx: {
    slug: string
    version: string
    slugOfSkill: (localId: string) => string | undefined
    modelHint?: string
    updatedAt: string
  },
): { manifest: RegistryAgentManifest; droppedSkillIds: string[] } {
  const droppedSkillIds: string[] = []
  const skillSlugs: string[] = []
  for (const localId of agent.skillIds ?? []) {
    const slug = ctx.slugOfSkill(localId)
    if (slug) skillSlugs.push(slug)
    else droppedSkillIds.push(localId)
  }
  const manifest: RegistryAgentManifest = {
    ...baseFields(ctx.slug, agent.name, ctx.version, ctx.updatedAt),
    ...(agent.description ? { description: agent.description } : {}),
    instructions: agent.instructions,
    ...(skillSlugs.length > 0 ? { skillIds: skillSlugs } : {}),
    ...(ctx.modelHint ? { modelHint: ctx.modelHint } : {}),
    ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
    ...(agent.maxTokens !== undefined ? { maxTokens: agent.maxTokens } : {}),
    ...(agent.outputConstraints ? { outputConstraints: agent.outputConstraints } : {}),
  }
  return { manifest, droppedSkillIds }
}

/**
 * YAML 特殊字符值加双引号包裹（`:`/`#`/换行/引号/括号会破坏 frontmatter 解析；
 * 与 upload.ts parseFrontmatter 的去引号 + 双引号反转义配套，保证导出→导入回环保真）。
 */
export function yamlSafe(s: string): string {
  return /[:#\n"'[\]{}]/.test(s)
    ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : s
}

/**
 * Skill → SKILL.md 文本：frontmatter(name/description) + content 原文。
 * discipline 已在 content 的 `## Discipline` 段时原样保留；仅在 discipline 字段存在而
 * content 缺段时补段（防用户在管理页只编辑了 discipline 字段导致导出丢失）。
 */
export function buildSkillMarkdown(skill: Skill): string {
  const fm: string[] = ['---', `name: ${yamlSafe(skill.name)}`]
  if (skill.description) fm.push(`description: ${yamlSafe(skill.description)}`)
  fm.push('---')
  let body = skill.content.trimEnd()
  if (skill.discipline && !extractDisciplineSection(body)) {
    body += `\n\n## Discipline\n\n${skill.discipline.trim()}`
  }
  return fm.join('\n') + '\n\n' + body + '\n'
}

/** Skill → manifest：hasScripts 由 zip 实际内容置位（调用方打包后传入） */
export function serializeSkillManifest(
  skill: Skill,
  ctx: { slug: string; version: string; hasScripts: boolean; updatedAt: string },
): RegistrySkillManifest {
  return {
    ...baseFields(ctx.slug, skill.name, ctx.version, ctx.updatedAt),
    ...(skill.description ? { description: skill.description } : {}),
    skillZip: 'skill.zip',
    ...(ctx.hasScripts ? { hasScripts: true } : {}),
    ...(skill.discipline ? { hasDiscipline: true } : {}),
  }
}

/**
 * Capability → manifest：图节点 data 的 skillIds/sourceAgentId 由本地 id 转 slug
 * （未映射剔除——取消勾选的依赖运行时降级不报错），剥离节点 modelId；
 * dependencies 从转换后图内容自动推导（§1.4：sourceAgentId 为空的手动节点不产生 agent 依赖）。
 */
export function serializeCapabilityManifest(
  capability: Capability,
  ctx: {
    slug: string
    version: string
    slugOfSkill: (localId: string) => string | undefined
    slugOfAgent: (localId: string) => string | undefined
    updatedAt: string
  },
): { manifest: RegistryCapabilityManifest; droppedSkillIds: string[]; droppedAgentIds: string[] } {
  const droppedSkillIds: string[] = []
  const droppedAgentIds: string[] = []
  const skillSlugs = new Set<string>()
  const agentSlugs = new Set<string>()

  const nodes = capability.graph.nodes.map((node) => {
    const data = { ...node.data }
    delete data.modelId // 本地模型 id 跨机器无意义（§3.3）

    if (Array.isArray(data.skillIds)) {
      const mapped: string[] = []
      for (const raw of data.skillIds as unknown[]) {
        const slug = ctx.slugOfSkill(String(raw))
        if (slug) {
          mapped.push(slug)
          skillSlugs.add(slug)
        } else {
          droppedSkillIds.push(String(raw))
        }
      }
      // 与 remap 侧同口径：空结果删字段，避免 [] 与 undefined 两种形态
      if (mapped.length > 0) data.skillIds = mapped
      else delete data.skillIds
    }

    // sourceAgentId（导出规范）+ agentId（旧字段，防御性兼容）
    for (const key of ['sourceAgentId', 'agentId'] as const) {
      const local = data[key]
      if (typeof local !== 'string' || !local) continue
      const slug = ctx.slugOfAgent(local)
      if (slug) {
        data[key] = slug
        agentSlugs.add(slug)
      } else {
        delete data[key]
        droppedAgentIds.push(local)
      }
    }
    return { ...node, data }
  })

  const graph: WorkflowGraph = { nodes, edges: capability.graph.edges }
  const dependencies =
    agentSlugs.size > 0 || skillSlugs.size > 0
      ? {
          ...(agentSlugs.size > 0 ? { agents: [...agentSlugs] } : {}),
          ...(skillSlugs.size > 0 ? { skills: [...skillSlugs] } : {}),
        }
      : undefined

  const manifest: RegistryCapabilityManifest = {
    ...baseFields(ctx.slug, capability.name, ctx.version, ctx.updatedAt),
    ...(capability.description ? { description: capability.description } : {}),
    graph,
    ...(dependencies ? { dependencies } : {}),
  }
  // dropped 仅用于日志：多节点引用同一未映射依赖时按 localId 去重，日志干净
  return {
    manifest,
    droppedSkillIds: [...new Set(droppedSkillIds)],
    droppedAgentIds: [...new Set(droppedAgentIds)],
  }
}
