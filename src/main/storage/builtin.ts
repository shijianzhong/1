import { cpSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  getBuiltinAgentsDir,
  getBuiltinCapabilitiesDir,
  getBuiltinSampleArticlesDir,
  getBuiltinSkillsDir,
  getBuiltinTemplatesDir,
  getBuiltinKbModelDir,
  getAgentsPath,
  getCapabilitiesDir,
  getSampleArticlesPath,
  getSkillsPath,
  getTemplatesPath,
  getKbModelDir,
} from './paths'
import { logger } from '../logger'

// —— 内置资产首启复制（docs/CONTENT_PIPELINE_PLAN.md §2.5）——
// builtin 出厂基线（build/builtin，随包 extraResources）→ userData 可写层。
//
// 引擎零侵入：复制进 userData 后与 custom 长得一模一样，引擎不区分也不在乎。
//
// 升级策略——强制覆盖：
//   每次启动用出厂源覆盖本地 builtin 副本（单文件直接覆盖，目录型逐子项覆盖）。
//   官方改了 builtin agent/skill/capability 定义后，升级即生效，老用户拿得到新版。
//
//   纪律前提：builtin 是出厂基线，不是用户草稿。用户要改 builtin 能力，应复制成
//   custom id（如 builtin_content_writer → my_content_writer）再改，不该直接改 builtin_
//   副本——直接改的会被下次升级覆盖。这和 seedDefaultModels 的 provider 基线同理。

/**
 * 目录型 builtin 资产回填（skill / sample-articles）：每个子目录是一独立资产。
 * 强制覆盖：逐子项用出厂源覆盖本地副本（保出厂最新；用户改过的 builtin 子项会被冲回）。
 * 不存在的子项新增，存在的覆盖，确保老用户升级拿到新加 builtin 子项 + 已有子项的最新版。
 */
function copyBuiltinSubdirsForce(srcDir: string, destDir: string, label: string): number {
  if (!existsSync(srcDir)) return 0
  const entries = readdirSync(srcDir, { withFileTypes: true }).filter((e) => e.isDirectory())
  let copied = 0
  for (const entry of entries) {
    const src = join(srcDir, entry.name)
    const dest = join(destDir, entry.name)
    cpSync(src, dest, { recursive: true, force: true })
    copied++
  }
  logger.info(
    `[builtin] ${label} 覆盖 ${copied}/${entries.length} 子项: ${srcDir} → ${destDir}`,
  )
  return copied
}

/**
 * 复制 builtin 单文件资产（agent/capability JSON、模板 HTML）。
 * 强制覆盖：目标文件已存在也用出厂源覆盖（保出厂最新），不存在则新增。
 * 按目录批量：源目录所有文件复制到目标目录，逐文件强制覆盖。
 */
function copyBuiltinFilesForce(srcDir: string, destDir: string, label: string): number {
  if (!existsSync(srcDir)) return 0
  let copied = 0
  const entries = readdirSync(srcDir, { withFileTypes: true }).filter((e) => e.isFile())
  for (const entry of entries) {
    const src = join(srcDir, entry.name)
    const dest = join(destDir, entry.name)
    cpSync(src, dest, { force: true })
    copied++
  }
  logger.info(
    `[builtin] ${label} 覆盖 ${copied}/${entries.length} 文件: ${srcDir} → ${destDir}`,
  )
  return copied
}

/**
 * 首启复制 builtin 资产基线进 userData 可写层（仿 seedDefaultModels 范式）。
 * 在 index.ts app.whenReady 内、seedDefaultModels 之后调用。
 *
 * 强制覆盖：每次启动用出厂源覆盖本地 builtin 副本，官方升级即生效。
 */
export function seedBuiltinAssets(): void {
  // agent（单 JSON 文件，builtin_*.json → config/agents/builtin_*.json）
  copyBuiltinFilesForce(getBuiltinAgentsDir(), getAgentsPath(), 'agents')

  // capability（单 JSON 文件）
  copyBuiltinFilesForce(getBuiltinCapabilitiesDir(), getCapabilitiesDir(), 'capabilities')

  // skill（目录，每个 skill 是一个子目录）——强制覆盖，升级拿得到最新 builtin skill
  copyBuiltinSubdirsForce(getBuiltinSkillsDir(), getSkillsPath(), 'skills')

  // 样文（目录，每个样文是一个子目录）——强制覆盖，后续补样文老用户即拿
  copyBuiltinSubdirsForce(
    getBuiltinSampleArticlesDir(),
    getSampleArticlesPath(),
    'sample-articles',
  )

  // 模板（单 HTML 文件）
  copyBuiltinFilesForce(getBuiltinTemplatesDir(), getTemplatesPath(), 'templates')
}

/**
 * P4: full 包首启复制预置模型权重（resources/kb-models → userData/kb-models）。
 * slim 包出厂源不存在 → no-op（运行时走 downloadKbModel 下载）。
 *
 * 与 seedBuiltinAssets 不同——**不强制覆盖**：模型权重 ~23MB，每次启动复制浪费。
 * 仅在目标目录无 .onnx 时复制（首启/被清空后重装才触发）。
 */
export function seedKbModel(): void {
  const src = getBuiltinKbModelDir()
  const dest = getKbModelDir()
  if (!existsSync(src)) return // slim 包无预置模型，运行时下载
  // 目标已有模型 → 不复制（避免每次启动复制 23MB）
  if (existsSync(dest)) {
    try {
      const entries = readdirSync(dest, { recursive: true })
      if (entries.some((e) => String(e).endsWith('.onnx'))) return
    } catch {
      // 空目录 / 读失败 → 继续复制
    }
  }
  // 先复制到临时目录再原子 rename（review #13）：23MB 拷贝中途崩溃若留半截 .onnx
  // 在 dest，下次启动「已有 .onnx」误判跳过复制 → 模型永久损坏无法自愈。
  // 失败不抛——模型可后续经 kb:downloadModel 运行时下载，不该拖垮启动。
  const tmp = `${dest}.seed-${process.pid}`
  try {
    rmSync(tmp, { recursive: true, force: true })
    cpSync(src, tmp, { recursive: true })
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
    renameSync(tmp, dest)
    logger.info(`[builtin] kb-models 复制: ${src} → ${dest}`)
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true })
    logger.warn('[builtin] kb-models 复制失败（可运行时下载补齐）', e)
  }
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
