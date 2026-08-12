import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Skill, SkillMeta } from '@shared/types'
import { getSkillsPath } from '../paths'
import { generateId } from '../json-store'
import { SkillInputSchema } from '../../config'
import { parseSkillMd, buildSkillMd } from './parser'
import { deleteSkillFts, upsertSkillFts } from './fts'
import { logger } from '../../logger'

// —— Skill 目录化存储（docs/SKILL_STORAGE_STANDARD_PLAN.md §五/§六）——
// 磁盘事实：config/skills/<skill-id>/SKILL.md + scripts/ + references/ + assets/
// 运行时投影：扫描目录 → Skill 对象（hasScripts 从目录扫描得出，不持久化）
//
// 不兼容旧 *.json 文件（§八 8.3）。目录扫描只认子目录，.json 文件被忽略。
// 缓存策略：save/remove 显式置 null；无 mtime 校验（目录数通常 <50，扫描成本低）。

/** 获取 skill 根目录（config/skills/<id>） */
export function getSkillDir(id: string): string {
  return join(getSkillsPath(), id)
}

/** 检测目录是否有 scripts/ 子目录且非空 */
function hasScriptsInDir(dir: string): boolean {
  const scriptsDir = join(dir, 'scripts')
  if (!existsSync(scriptsDir)) return false
  try {
    return readdirSync(scriptsDir, { withFileTypes: true }).some((e) => e.isFile())
  } catch {
    return false
  }
}

/** 扫描单个 skill 目录 → Skill 对象；无 SKILL.md 返回 null */
function scanSkillDir(dir: string): Skill | null {
  const skillMdPath = join(dir, 'SKILL.md')
  if (!existsSync(skillMdPath)) return null

  let text: string
  try {
    text = readFileSync(skillMdPath, 'utf8')
  } catch {
    return null
  }

  const parsed = parseSkillMd(text)
  if (!parsed) return null

  let stat: { mtimeMs: number; birthtimeMs: number }
  try {
    const s = statSync(skillMdPath)
    stat = { mtimeMs: s.mtimeMs, birthtimeMs: s.birthtimeMs }
  } catch {
    stat = { mtimeMs: 0, birthtimeMs: 0 }
  }

  const id = basename(dir)
  return {
    id,
    name: parsed.name,
    description: parsed.description,
    content: parsed.content,
    discipline: parsed.discipline,
    hasScripts: hasScriptsInDir(dir),
    registry: parsed.registry,
    createdAt: stat.birthtimeMs || stat.mtimeMs,
    updatedAt: stat.mtimeMs,
  }
}

// —— 缓存 ——
let skillsCache: Skill[] | null = null

/** 失效 skills 缓存。供外部直接改写 skill 目录（如 extractSkillResourcesToDir
 * 写入 scripts/）后调用，避免 listSkillMetas 读到 extract 前的中间态（hasScripts=false）。 */
export function invalidateSkillsCache(): void {
  skillsCache = null
}

function getCachedSkills(): Skill[] {
  if (skillsCache) return skillsCache
  const dir = getSkillsPath()
  if (!existsSync(dir)) {
    skillsCache = []
    return skillsCache
  }
  const skills: Skill[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    // 跳过上传临时目录残留（skl_upload_ 前缀，旧格式遗留）
    if (entry.name.startsWith('skl_upload_')) continue
    const skill = scanSkillDir(join(dir, entry.name))
    if (skill) skills.push(skill)
  }
  skills.sort((a, b) => b.updatedAt - a.updatedAt)
  skillsCache = skills
  return skills
}

// —— 对外 API（与旧 models.ts 签名一致，调用方无需改动 import 路径）——

export function listSkills(): Skill[] {
  return getCachedSkills()
}

export function listSkillMetas(): SkillMeta[] {
  return getCachedSkills().map(({ content, ...meta }) => ({
    ...meta,
    contentLength: content.length,
  }))
}

export function countSkills(): number {
  // 复用缓存（与 listSkills 同源），确保计数口径一致（仅含 SKILL.md 的目录）
  return getCachedSkills().length
}

export function getSkill(id: string): Skill | null {
  const dir = getSkillDir(id)
  if (!existsSync(dir)) return null
  return scanSkillDir(dir)
}

export function saveSkill(input: unknown, opts?: { now?: number }): Skill {
  const parsed = SkillInputSchema.parse(input)
  const now = opts?.now ?? Date.now()
  const existing = parsed.id ? getSkill(parsed.id) : null
  const id = existing?.id ?? generateId('skl_')
  const dir = getSkillDir(id)

  const skill: Skill = {
    id,
    name: parsed.name,
    description: parsed.description,
    content: parsed.content,
    // 编辑表单不携带 discipline 时保留既有值（防编辑保存误清 propose_skill/导入写入的纪律段）
    discipline: parsed.discipline ?? existing?.discipline,
    // hasScripts 从目录扫描得出，不由输入控制
    hasScripts: existing?.hasScripts ?? false,
    registry: parsed.registry ?? existing?.registry,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }

  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), buildSkillMd(skill), 'utf8')

  // 重新扫描以更新 hasScripts（导入/上传场景在 save 后才提取脚本）
  const refreshed = scanSkillDir(dir)
  const finalSkill = refreshed ?? skill

  upsertSkillFts(finalSkill)
  skillsCache = null

  return finalSkill
}

export function removeSkill(id: string): void {
  const dir = getSkillDir(id)
  rmSync(dir, { recursive: true, force: true })
  deleteSkillFts(id)
  skillsCache = null
  logger.info(`[skill-store] 已删除技能目录 ${id}`)
}
