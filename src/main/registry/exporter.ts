import AdmZip from 'adm-zip'
import { mkdir, readdir } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type {
  Agent,
  RegistryExportConfirmItem,
  RegistryExportPlan,
  RegistryExportPlanItem,
  RegistryExportResult,
  Skill,
} from '@shared/types'
import { logger } from '../logger'
import { getSkillUploadTempDir } from '../skills/upload'
import {
  getAgent,
  getCapability,
  getModel,
  getSkill,
  saveAgent,
  saveCapability,
  saveSkill,
} from '../storage/models'
import { writeJsonFile } from '../storage/json-store'
import { isValidSlug, loadRegistryConfig } from './sources'
import {
  buildSkillMarkdown,
  bumpPatch,
  serializeAgentManifest,
  serializeCapabilityManifest,
  serializeSkillManifest,
  slugify,
} from './serialize'

// —— Registry 导出（docs/REGISTRY_PLAN.md §3.3 级联推送，Phase 3）——
// planExport：按级联规则收集资产（Skill 仅自身 / Agent + 其 Skills /
// Capability + 图引用 Skills + sourceAgentId 物化 Agents），预填 slug/version 供预览编辑；
// applyExport：序列化（serialize.ts 纯函数）+ skill zip 重组 → 落盘用户所选目录
// （one-registry-export/ 子目录，结构即仓库规范），最后回写本地 provenance。

const EXPORT_DIR_NAME = 'one-registry-export'

function planItemFor(
  kind: RegistryExportPlanItem['kind'],
  localId: string,
  name: string,
  provenance: { registryId: string; version: string } | undefined,
  auto: boolean,
): RegistryExportPlanItem {
  const slug = provenance?.registryId ?? (slugify(name) || `${kind}-${Date.now().toString(36)}`)
  return {
    kind,
    localId,
    name,
    slug,
    version: provenance ? bumpPatch(provenance.version) : '1.0.0',
    status: provenance ? 'update' : 'new',
    ...(auto ? { auto: true } : {}),
  }
}

/** 级联收集：主资产 + 依赖，去重（同 localId 只出现一次，主资产优先） */
export function planExport(
  kind: 'agent' | 'skill' | 'capability',
  localId: string,
): RegistryExportPlan {
  const items: RegistryExportPlanItem[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  const push = (item: RegistryExportPlanItem): void => {
    const key = `${item.kind}:${item.localId}`
    if (seen.has(key)) return
    seen.add(key)
    items.push(item)
  }
  const pushSkill = (skill: Skill, auto: boolean): void =>
    push(planItemFor('skill', skill.id, skill.name, skill.registry, auto))
  const pushAgent = (agent: Agent, auto: boolean): void => {
    push(planItemFor('agent', agent.id, agent.name, agent.registry, auto))
    for (const sid of agent.skillIds ?? []) {
      const skill = getSkill(sid)
      if (skill) pushSkill(skill, true)
      else warnings.push(`角色「${agent.name}」引用的技能 ${sid} 本地不存在，导出时将剔除`)
    }
  }

  if (kind === 'skill') {
    const skill = getSkill(localId)
    if (!skill) throw new Error(`技能不存在：${localId}`)
    pushSkill(skill, false)
  } else if (kind === 'agent') {
    const agent = getAgent(localId)
    if (!agent) throw new Error(`角色不存在：${localId}`)
    pushAgent(agent, false)
  } else {
    const capability = getCapability(localId)
    if (!capability) throw new Error(`能力不存在：${localId}`)
    push(planItemFor('capability', capability.id, capability.name, capability.registry, false))
    // 图引用依赖（§3.3：图内所有 Skill + sourceAgentId 物化所需 Agent）
    for (const node of capability.graph.nodes) {
      const data = node.data as Record<string, unknown>
      for (const raw of Array.isArray(data.skillIds) ? (data.skillIds as unknown[]) : []) {
        const skill = getSkill(String(raw))
        if (skill) pushSkill(skill, true)
        else warnings.push(`能力「${capability.name}」图节点引用的技能 ${String(raw)} 本地不存在，导出时将剔除`)
      }
      for (const key of ['sourceAgentId', 'agentId'] as const) {
        const ref = data[key]
        if (typeof ref !== 'string' || !ref) continue
        const agent = getAgent(ref)
        if (agent) pushAgent(agent, true)
        else warnings.push(`能力「${capability.name}」图节点引用的角色 ${ref} 本地不存在，导出时将剔除`)
      }
    }
  }
  return { items, warnings }
}

/** 递归收集 skill 解压临时目录下的 resources/references/assets/scripts 文件 */
async function collectSkillZipEntries(tempDir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out.push(full)
    }
  }
  for (const top of ['scripts', 'resources', 'references', 'assets']) {
    await walk(join(tempDir, top)) // 目录不存在时 walk 内 readdir catch 为空，属正常
  }
  return out
}

/** 重组 skill.zip：SKILL.md（根）+ 按 scriptPath 反查的临时目录资源（设计基线 5） */
async function buildSkillZip(skill: Skill, outPath: string): Promise<{ hasScripts: boolean }> {
  const zip = new AdmZip()
  zip.addFile('SKILL.md', Buffer.from(buildSkillMarkdown(skill), 'utf8'))
  let hasScripts = false
  if (skill.scriptPath) {
    const tempDir = getSkillUploadTempDir(skill.scriptPath)
    if (tempDir) {
      for (const file of await collectSkillZipEntries(tempDir)) {
        const rel = file.slice(tempDir.length + 1).split(sep).join('/')
        const zipDir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
        zip.addLocalFile(file, zipDir)
        if (rel.startsWith('scripts/')) hasScripts = true
      }
    }
  }
  zip.writeZip(outPath)
  return { hasScripts }
}

export async function applyExport(
  items: RegistryExportConfirmItem[],
  targetDir: string,
): Promise<RegistryExportResult> {
  if (items.length === 0) throw new Error('导出清单为空')
  // slug 合法性 + 跨类型唯一 + version semver（对齐仓库 validate CI 规则，提前在本地拦下）
  const slugSeen = new Set<string>()
  for (const item of items) {
    if (!isValidSlug(item.slug)) throw new Error(`非法 slug：${item.slug}（仅小写字母/数字/连字符）`)
    if (slugSeen.has(item.slug)) throw new Error(`slug 冲突：${item.slug} 在导出清单中重复`)
    slugSeen.add(item.slug)
    if (!/^\d+\.\d+\.\d+$/.test(item.version.trim())) {
      throw new Error(`版本号需为 semver x.y.z：${item.slug}（当前 "${item.version}"）`)
    }
  }

  const root = join(targetDir, EXPORT_DIR_NAME)
  const updatedAt = new Date().toISOString()
  const files: string[] = []
  const slugOfSkill = new Map<string, string>()
  const slugOfAgent = new Map<string, string>()
  for (const item of items) {
    if (item.kind === 'skill') slugOfSkill.set(item.localId, item.slug)
    if (item.kind === 'agent') slugOfAgent.set(item.localId, item.slug)
  }
  const skillSlugs = (localId: string): string | undefined => slugOfSkill.get(localId)
  const agentSlugs = (localId: string): string | undefined => slugOfAgent.get(localId)

  const writeManifest = (rel: string, manifest: unknown): void => {
    writeJsonFile(join(root, rel), manifest) // 原子写 + 自动建目录
    files.push(rel)
  }

  // 顺序保证：skills → agents → capability（capability 序列化依赖前两者映射）
  const now = Date.now()
  for (const item of items.filter((i) => i.kind === 'skill')) {
    const skill = getSkill(item.localId)
    if (!skill) throw new Error(`技能不存在：${item.localId}`)
    const zipRel = join('skills', item.slug, 'skill.zip')
    await mkdir(join(root, 'skills', item.slug), { recursive: true })
    const { hasScripts } = await buildSkillZip(skill, join(root, zipRel))
    files.push(zipRel)
    writeManifest(
      join('skills', item.slug, 'manifest.json'),
      serializeSkillManifest(skill, { slug: item.slug, version: item.version, hasScripts, updatedAt }),
    )
    // spread 原实体 + 覆盖 registry：未来新增字段自动保留，防手动列举静默丢字段
    // （教训：曾漏 source 致导出后 builtin 被洗成 custom；Zod 会 strip createdAt/updatedAt，save 内部按 existing 处理）
    saveSkill(
      {
        ...skill,
        registry: { registryId: item.slug, version: item.version, importedAt: now },
      },
      { now },
    )
  }
  for (const item of items.filter((i) => i.kind === 'agent')) {
    const agent = getAgent(item.localId)
    if (!agent) throw new Error(`角色不存在：${item.localId}`)
    const { manifest, droppedSkillIds } = serializeAgentManifest(agent, {
      slug: item.slug,
      version: item.version,
      slugOfSkill: skillSlugs,
      modelHint: agent.modelId ? (getModel(agent.modelId)?.modelId ?? undefined) : undefined,
      updatedAt,
    })
    if (droppedSkillIds.length > 0) {
      logger.warn(`[registry] 导出角色 ${item.slug} 剔除未勾选技能引用：${droppedSkillIds.join(', ')}`)
    }
    writeManifest(join('agents', item.slug, 'manifest.json'), manifest)
    saveAgent(
      {
        ...agent,
        registry: { registryId: item.slug, version: item.version, importedAt: now },
      },
      { now },
    )
  }
  for (const item of items.filter((i) => i.kind === 'capability')) {
    const capability = getCapability(item.localId)
    if (!capability) throw new Error(`能力不存在：${item.localId}`)
    const { manifest, droppedSkillIds, droppedAgentIds } = serializeCapabilityManifest(capability, {
      slug: item.slug,
      version: item.version,
      slugOfSkill: skillSlugs,
      slugOfAgent: agentSlugs,
      updatedAt,
    })
    if (droppedSkillIds.length > 0 || droppedAgentIds.length > 0) {
      logger.warn(
        `[registry] 导出能力 ${item.slug} 剔除未勾选依赖引用：skills=[${droppedSkillIds.join(', ')}] agents=[${droppedAgentIds.join(', ')}]`,
      )
    }
    writeManifest(join('capabilities', item.slug, 'manifest.json'), manifest)
    saveCapability(
      {
        ...capability,
        registry: { registryId: item.slug, version: item.version, importedAt: now },
      },
      { now },
    )
  }

  logger.info(`[registry] 导出完成：${root}（${files.length} 个文件）`)
  return { dir: root, files }
}

/** 贡献页 URL（方式 A 引导：fork + 手动 PR，§3.3 步骤 4） */
export function getContributeUrl(): string {
  const repo = loadRegistryConfig().repo
  return `https://github.com/${repo}/blob/main/README.md#contributing`
}
