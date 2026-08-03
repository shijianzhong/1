import type {
  Agent,
  Capability,
  RegistryAgentManifest,
  RegistryAssetKind,
  RegistryCapabilityManifest,
  RegistryImportPlan,
  RegistryImportPlanItem,
  RegistryImportResult,
  RegistrySkillManifest,
  Skill,
} from '@shared/types'
import { rm } from 'node:fs/promises'
import { logger } from '../logger'
import { getSkillUploadTempDir, parseSkillZip, uploadSkillFile } from '../skills/upload'
import {
  listAgents,
  listCapabilities,
  listSkills,
  saveAgent,
  saveCapability,
  saveSkill,
} from '../storage/models'
import { remapGraphForImport } from './remap'
import { downloadSkillZip, getRegistryManifest } from './service'

// —— Registry 导入（docs/REGISTRY_PLAN.md §3.2 三条链路 + §2.2 身份映射）——
// planImport：解析依赖树 + 下载 skill zip 列脚本 → 确认框数据；
// applyImport：同一解析逻辑落盘（zip 走 5 分钟缓存复用，不重复下载）。
// 身份映射铁律：registry slug ↔ 本地 id 经 provenance 桥接；导入重映射、不回填 slug。

function findSkillBySlug(slug: string): Skill | undefined {
  return listSkills().find((s) => s.registry?.registryId === slug)
}

function findAgentBySlug(slug: string): Agent | undefined {
  return listAgents().find((a) => a.registry?.registryId === slug)
}

function findCapabilityBySlug(slug: string): Capability | undefined {
  return listCapabilities().find((c) => c.registry?.registryId === slug)
}

function statusOf(localVersion: string | undefined, remoteVersion: string): 'installed' | 'update' {
  return localVersion === remoteVersion ? 'installed' : 'update'
}

/**
 * 本地修改冲突检测（§2.3）：导入后本地改过（updatedAt > importedAt）→ 默认跳过防覆盖。
 * 导入落盘时经 save*(…, { now }) 使 importedAt == updatedAt，故严格大于即代表真实本地编辑。
 */
function isLocallyModified(entity: { updatedAt: number; registry?: { importedAt: number } }): boolean {
  return !!entity.registry && entity.updatedAt > entity.registry.importedAt
}

function provenanceOf(
  manifest: RegistryAgentManifest | RegistrySkillManifest | RegistryCapabilityManifest,
  now: number,
) {
  return {
    registryId: manifest.id,
    version: manifest.version,
    author: manifest.author,
    importedAt: now,
  }
}

// —— Skill ——

async function planSkillItem(slug: string): Promise<RegistryImportPlanItem> {
  const manifest = await getRegistryManifest('skill', slug)
  const existing = findSkillBySlug(slug)
  if (existing && existing.registry?.version === manifest.version) {
    return { kind: 'skill', slug, name: manifest.name, status: 'installed' }
  }
  // 新装/更新都要列出脚本文件名（确认框警告，§5.2）
  const zipPath = await downloadSkillZip(slug)
  let scripts: string[] | undefined
  try {
    const parsed = await parseSkillZip(zipPath)
    scripts = parsed.scripts && parsed.scripts.length > 0 ? parsed.scripts : undefined
  } catch (error) {
    // plan 阶段不阻断：脚本清单仅用于确认框展示；zip 损坏时 apply 阶段 uploadSkillFile 会重新校验并报错
    logger.warn(`[registry] plan 阶段解析技能 ${slug} 压缩包失败（apply 将重新校验）`, error)
  }
  return {
    kind: 'skill',
    slug,
    name: manifest.name,
    status: existing ? 'update' : 'new',
    scripts,
  }
}

/** 落盘 skill（新装或覆盖更新保留本地 id）；modified=true 表示本地已修改跳过覆盖，沿用旧实体 */
async function applySkillImport(
  slug: string,
): Promise<{ localId: string; name: string; modified?: boolean }> {
  const manifest = await getRegistryManifest('skill', slug)
  const existing = findSkillBySlug(slug)
  if (existing && isLocallyModified(existing)) {
    logger.info(`[registry] 技能 ${slug} 导入后本地已修改，跳过覆盖（§2.3）`)
    return { localId: existing.id, name: existing.name, modified: true }
  }
  const zipPath = await downloadSkillZip(slug)
  // 更新场景：先记录旧解压目录，saveSkill 成功后清理，防磁盘积累孤立文件
  const oldTempDir = existing?.scriptPath ? getSkillUploadTempDir(existing.scriptPath) : null
  const { parsed, scriptPath } = await uploadSkillFile(zipPath)
  const now = Date.now()
  const saved = saveSkill(
    {
      id: existing?.id,
      name: parsed.name || manifest.name,
      description: parsed.description ?? manifest.description,
      content: parsed.content,
      discipline: parsed.discipline,
      scriptPath,
      registry: provenanceOf(manifest, now),
    },
    { now },
  )
  const newTempDir = scriptPath ? getSkillUploadTempDir(scriptPath) : null
  if (oldTempDir && oldTempDir !== newTempDir) {
    await rm(oldTempDir, { recursive: true, force: true }).catch(() => {})
  }
  return { localId: saved.id, name: saved.name }
}

/** 确保 skill 在本地可用：同版本复用，否则导入/更新 */
async function ensureSkillLocal(slug: string): Promise<string> {
  const manifest = await getRegistryManifest('skill', slug)
  const existing = findSkillBySlug(slug)
  if (existing && existing.registry?.version === manifest.version) return existing.id
  return (await applySkillImport(slug)).localId
}

// —— Agent（级联 skills）——

async function planAgentItems(slug: string): Promise<RegistryImportPlanItem[]> {
  const manifest = await getRegistryManifest('agent', slug)
  const items: RegistryImportPlanItem[] = []
  for (const skillSlug of manifest.skillIds ?? []) {
    items.push(await planSkillItem(skillSlug))
  }
  const existing = findAgentBySlug(slug)
  items.push({
    kind: 'agent',
    slug,
    name: manifest.name,
    status: existing ? statusOf(existing.registry?.version, manifest.version) : 'new',
  })
  return items
}

/** 落盘 agent（级联确保 skills），返回本地 id 与其引用的 skill slug 列表；modified=true 表示本地已修改跳过覆盖 */
async function applyAgentImport(
  slug: string,
): Promise<{ localId: string; skillSlugs: string[]; modified?: boolean }> {
  const manifest = await getRegistryManifest('agent', slug)
  const existing = findAgentBySlug(slug)
  if (existing && isLocallyModified(existing)) {
    logger.info(`[registry] 角色 ${slug} 导入后本地已修改，跳过覆盖（§2.3）`)
    return { localId: existing.id, skillSlugs: manifest.skillIds ?? [], modified: true }
  }
  const skillIds: string[] = []
  for (const skillSlug of manifest.skillIds ?? []) {
    try {
      skillIds.push(await ensureSkillLocal(skillSlug))
    } catch (error) {
      // 单个依赖缺失不阻断 agent 导入：剔除 + 告警（§3.2）
      logger.warn(`[registry] agent ${slug} 依赖技能 ${skillSlug} 导入失败，已剔除`, error)
    }
  }
  const now = Date.now()
  const saved = saveAgent(
    {
      id: existing?.id,
      name: manifest.name,
      description: manifest.description,
      instructions: manifest.instructions,
      skillIds: skillIds.length > 0 ? skillIds : undefined,
      // modelId 不可移植，导入不设（回退默认模型）；modelHint 仅详情页展示
      temperature: manifest.temperature,
      maxTokens: manifest.maxTokens,
      outputConstraints: manifest.outputConstraints,
      registry: provenanceOf(manifest, now),
    },
    { now },
  )
  return { localId: saved.id, skillSlugs: manifest.skillIds ?? [] }
}

// —— Capability（级联 agents + skills，图重映射）——

async function planCapabilityItems(slug: string): Promise<RegistryImportPlanItem[]> {
  const manifest = await getRegistryManifest('capability', slug)
  const items: RegistryImportPlanItem[] = []
  for (const skillSlug of manifest.dependencies?.skills ?? []) {
    items.push(await planSkillItem(skillSlug))
  }
  for (const agentSlug of manifest.dependencies?.agents ?? []) {
    // 级联：agent 自身的 skill 依赖一并列出（递归）
    items.push(...(await planAgentItems(agentSlug)))
  }
  const existing = findCapabilityBySlug(slug)
  items.push({
    kind: 'capability',
    slug,
    name: manifest.name,
    status: existing ? statusOf(existing.registry?.version, manifest.version) : 'new',
  })
  return items
}

async function applyCapabilityImport(
  slug: string,
  opts: { materializeAgents: boolean },
): Promise<{ localId: string; name: string; droppedSkillSlugs: string[]; modified?: boolean }> {
  const manifest = await getRegistryManifest('capability', slug)
  const existingCap = findCapabilityBySlug(slug)
  if (existingCap && isLocallyModified(existingCap)) {
    logger.info(`[registry] 能力 ${slug} 导入后本地已修改，跳过覆盖（§2.3）`)
    return { localId: existingCap.id, name: existingCap.name, droppedSkillSlugs: [], modified: true }
  }

  const skillMap = new Map<string, string>()
  for (const skillSlug of manifest.dependencies?.skills ?? []) {
    try {
      skillMap.set(skillSlug, await ensureSkillLocal(skillSlug))
    } catch (error) {
      logger.warn(`[registry] capability ${slug} 依赖技能 ${skillSlug} 导入失败，图引用将被剔除`, error)
    }
  }

  const agentMap = new Map<string, string>()
  if (opts.materializeAgents) {
    for (const agentSlug of manifest.dependencies?.agents ?? []) {
      try {
        const { localId, skillSlugs } = await applyAgentImport(agentSlug)
        agentMap.set(agentSlug, localId)
        // agent 级联带入的 skill 也进映射表（图节点可能直接引用）
        for (const s of skillSlugs) {
          if (!skillMap.has(s)) {
            const local = findSkillBySlug(s)
            if (local) skillMap.set(s, local.id)
          }
        }
      } catch (error) {
        logger.warn(`[registry] capability ${slug} 依赖角色 ${agentSlug} 导入失败，图引用将被剔除`, error)
      }
    }
  }

  const { graph, droppedSkillSlugs } = remapGraphForImport(
    manifest.graph,
    { skills: skillMap, agents: agentMap },
    opts,
  )
  const now = Date.now()
  const saved = saveCapability(
    {
      id: existingCap?.id,
      name: manifest.name,
      description: manifest.description,
      graph,
      registry: provenanceOf(manifest, now),
    },
    { now },
  )
  return { localId: saved.id, name: saved.name, droppedSkillSlugs }
}

// —— 对外：plan / apply ——

function dedupItems(items: RegistryImportPlanItem[]): RegistryImportPlanItem[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.kind}:${item.slug}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function planImport(
  kind: RegistryAssetKind,
  slug: string,
): Promise<RegistryImportPlan> {
  const items = dedupItems(
    kind === 'skill'
      ? [await planSkillItem(slug)]
      : kind === 'agent'
        ? await planAgentItems(slug)
        : await planCapabilityItems(slug),
  )
  return { items, hasScripts: items.some((i) => (i.scripts?.length ?? 0) > 0) }
}

export async function applyImport(
  kind: RegistryAssetKind,
  slug: string,
  opts?: { materializeAgents?: boolean },
): Promise<RegistryImportResult> {
  const result: RegistryImportResult = { imported: [], skipped: [] }
  if (kind === 'skill') {
    const manifest = await getRegistryManifest('skill', slug)
    const existing = findSkillBySlug(slug)
    if (existing && existing.registry?.version === manifest.version) {
      result.skipped.push({ kind, slug, name: manifest.name, reason: 'installed' })
      return result
    }
    const outcome = await applySkillImport(slug)
    if (outcome.modified) {
      result.skipped.push({ kind, slug, name: outcome.name, reason: 'locally_modified' })
    } else {
      result.imported.push({ kind, slug, localId: outcome.localId, name: outcome.name })
    }
    return result
  }
  if (kind === 'agent') {
    const manifest = await getRegistryManifest('agent', slug)
    const existing = findAgentBySlug(slug)
    if (existing && existing.registry?.version === manifest.version) {
      result.skipped.push({ kind, slug, name: manifest.name, reason: 'installed' })
      return result
    }
    const outcome = await applyAgentImport(slug)
    if (outcome.modified) {
      result.skipped.push({ kind, slug, name: manifest.name, reason: 'locally_modified' })
    } else {
      result.imported.push({ kind, slug, localId: outcome.localId, name: manifest.name })
    }
    return result
  }
  const manifest = await getRegistryManifest('capability', slug)
  const existing = findCapabilityBySlug(slug)
  if (existing && existing.registry?.version === manifest.version) {
    result.skipped.push({ kind, slug, name: manifest.name, reason: 'installed' })
    return result
  }
  const outcome = await applyCapabilityImport(slug, {
    materializeAgents: opts?.materializeAgents ?? true,
  })
  if (outcome.modified) {
    result.skipped.push({ kind, slug, name: outcome.name, reason: 'locally_modified' })
    return result
  }
  result.imported.push({ kind, slug, localId: outcome.localId, name: outcome.name })
  if (outcome.droppedSkillSlugs.length > 0) result.droppedSkillSlugs = outcome.droppedSkillSlugs
  return result
}
