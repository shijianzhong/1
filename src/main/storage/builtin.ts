import { cpSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  getBuiltinAgentsDir,
  getBuiltinCapabilitiesDir,
  getBuiltinSampleArticlesDir,
  getBuiltinSkillsDir,
  getBuiltinTemplatesDir,
  getAgentsPath,
  getCapabilitiesDir,
  getSampleArticlesPath,
  getSkillsPath,
  getTemplatesPath,
} from './paths'
import { logger } from '../logger'

// —— 内置资产首启复制（docs/CONTENT_PIPELINE_PLAN.md §2.5）——
// builtin 出厂基线（build/builtin，随包 extraResources）→ userData 可写层。
// 用户可改自己那份副本，改完走现有 Registry 导出/导入分享给他人。
//
// 引擎零侵入：复制进 userData 后与 custom 长得一模一样，引擎不区分也不在乎。
//
// 升级判定（实用主义，非 registry.isLocallyModified）：
//   目标已存在 → 视为"已落地"，跳过覆盖（不管用户改没改过，都不破坏用户现有状态）。
//   官方升级 builtin 资产版本号后，走显式提示路径（后续 P3 填资产时细化），
//   不自动覆盖——保住用户改动是第一优先级。
//   理由：builtin 基线不带 registry provenance（非 registry 导入），没有 importedAt
//   锚点判定"改没改过"；靠 mtime 不可靠（用户可能改完又改回）。存在即跳过最安全。

/**
 * 目录型 builtin 资产回填（skill / sample-articles）：每个子目录是一独立资产。
 * 逐子项判存在：目标子目录已存在 → 跳过（保用户对该资产的改动）；不存在 → 复制。
 *
 * 这样老用户升级时能收到新加的 builtin 子项（如后续新增的 skill / 样文），
 * 而非"目标根目录已存在就整包跳过"——后者只首装拷贝、不向现有安装补发缺失 builtin。
 */
function copyBuiltinSubdirsIfAbsent(srcDir: string, destDir: string, label: string): number {
  if (!existsSync(srcDir)) return 0
  const entries = readdirSync(srcDir, { withFileTypes: true }).filter((e) => e.isDirectory())
  let copied = 0
  for (const entry of entries) {
    const src = join(srcDir, entry.name)
    const dest = join(destDir, entry.name)
    if (existsSync(dest)) continue // 该资产已落地，跳过（保用户改动）
    cpSync(src, dest, { recursive: true })
    copied++
  }
  logger.info(
    `[builtin] ${label} 回填 ${copied}/${entries.length} 子项: ${srcDir} → ${destDir}`,
  )
  return copied
}

/**
 * 复制 builtin 单文件资产（agent/capability JSON、模板 HTML）。
 * 目标文件已存在 → 跳过；不存在 → 复制。
 * 按目录批量：源目录所有文件复制到目标目录，逐文件判存在。
 */
function copyBuiltinFilesIfAbsent(srcDir: string, destDir: string, label: string): number {
  if (!existsSync(srcDir)) return 0
  let copied = 0
  const entries = readdirSync(srcDir, { withFileTypes: true }).filter((e) => e.isFile())
  for (const entry of entries) {
    const src = join(srcDir, entry.name)
    const dest = join(destDir, entry.name)
    if (existsSync(dest)) continue // 已落地，跳过
    cpSync(src, dest)
    copied++
  }
  logger.info(
    `[builtin] ${label} 首启复制 ${copied}/${entries.length} 文件: ${srcDir} → ${destDir}`,
  )
  return copied
}

/**
 * 首启复制 builtin 资产基线进 userData 可写层（仿 seedDefaultModels 范式）。
 * 在 index.ts app.whenReady 内、seedDefaultModels 之后调用。
 *
 * 幂等：目标已存在即跳过。每类资产独立复制，互不影响。
 */
export function seedBuiltinAssets(): void {
  // agent（单 JSON 文件，builtin_*.json → config/agents/builtin_*.json）
  copyBuiltinFilesIfAbsent(getBuiltinAgentsDir(), getAgentsPath(), 'agents')

  // capability（单 JSON 文件）
  copyBuiltinFilesIfAbsent(getBuiltinCapabilitiesDir(), getCapabilitiesDir(), 'capabilities')

  // skill（目录，每个 skill 是一个子目录）——逐子项回填，老用户升级能收到新加的 builtin skill
  copyBuiltinSubdirsIfAbsent(getBuiltinSkillsDir(), getSkillsPath(), 'skills')

  // 样文（目录，每个样文是一个子目录）——逐子项回填，后续补样文时老用户也能收到
  copyBuiltinSubdirsIfAbsent(
    getBuiltinSampleArticlesDir(),
    getSampleArticlesPath(),
    'sample-articles',
  )

  // 模板（单 HTML 文件）
  copyBuiltinFilesIfAbsent(getBuiltinTemplatesDir(), getTemplatesPath(), 'templates')
}

/**
 * 列出 builtin 出厂源有哪些资产（诊断用：看随包内置了什么）。
 * 返回各类的 id 列表（agent/capability 去扩展名，skill/样文取目录名）。
 */
export function listBuiltinAssets(): {
  agents: string[]
  capabilities: string[]
  skills: string[]
  sampleArticles: string[]
  templates: string[]
} {
  const listFiles = (dir: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => e.name.replace(/\.\w+$/, ''))
          .filter((name) => name.length > 0 && !name.startsWith('.'))
      : []
  const listDirs = (dir: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .filter((name) => name.length > 0 && !name.startsWith('.'))
      : []
  return {
    agents: listFiles(getBuiltinAgentsDir()),
    capabilities: listFiles(getBuiltinCapabilitiesDir()),
    skills: listDirs(getBuiltinSkillsDir()),
    sampleArticles: listDirs(getBuiltinSampleArticlesDir()),
    templates: listFiles(getBuiltinTemplatesDir()),
  }
}

/** builtin 资产是否已落地（userData 可写层有对应项）——诊断用 */
export function isBuiltinSeeded(): boolean {
  return (
    existsSync(join(getAgentsPath(), 'builtin_content_researcher.json')) ||
    existsSync(join(getSkillsPath(), 'topic-research-discipline'))
  )
}
