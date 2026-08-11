import AdmZip from 'adm-zip'
import { readFile } from 'node:fs/promises'
import { basename, extname, join, sep } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { IpcErrorThrow } from '@shared/types'
import { parseFrontmatter, extractDisciplineSection } from '../storage/skills/parser'

// —— 技能包上传与导入（目录化标准格式，docs/SKILL_STORAGE_STANDARD_PLAN.md §5.5/§6.4）——
// 仅支持 .zip 格式：
//   .zip → 压缩包，查找 SKILL.md，解析 frontmatter，正文为 content
//          resources/ 和 scripts/ 子目录直接解压到 config/skills/<skillId>/
// 路径穿越防护：所有解压路径必须落在目标目录内。

const MAX_ARCHIVE_SIZE = 10 * 1024 * 1024 // 10MB
const MAX_FILE_COUNT = 200

export interface ParsedSkill {
  name: string
  description?: string
  content: string
  /** 输出纪律段（frontmatter `discipline` 优先，回退 `## Discipline` 段落） */
  discipline?: string
  /** 从 zip 中提取的资源文件相对路径列表 */
  resources?: string[]
  /** 从 zip 中提取的脚本文件相对路径列表 */
  scripts?: string[]
}

function fallbackDescription(body: string): string | undefined {
  const text = body.replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, 120) : undefined
}

/** 从文件名生成默认 skill 名 */
function nameFromFilename(filePath: string): string {
  const base = basename(filePath, extname(filePath))
  return base.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '_').slice(0, 64) || 'unnamed_skill'
}

/** 解析 ZIP 压缩包，提取 SKILL.md + resources/ + scripts/ */
export async function parseSkillZip(
  filePath: string,
  overrideName?: string,
): Promise<ParsedSkill> {
  const data = await readFile(filePath)
  if (data.length > MAX_ARCHIVE_SIZE) {
    throw new Error(`压缩包过大（${(data.length / 1024 / 1024).toFixed(1)}MB），上限 ${MAX_ARCHIVE_SIZE / 1024 / 1024}MB`)
  }

  const zip = new AdmZip(data)
  const entries = zip.getEntries()

  // 过滤：排除目录条目和 __MACOSX
  const files = entries.filter(
    (e) => !e.isDirectory && !e.entryName.startsWith('__MACOSX/'),
  )

  if (files.length > MAX_FILE_COUNT) {
    throw new Error(`压缩包内文件数过多（${files.length}），上限 ${MAX_FILE_COUNT}`)
  }

  // 查找 SKILL.md（取路径最短的那个作为技能根）
  const skillMdEntries = files
    .filter((e) => basename(e.entryName).toLowerCase() === 'skill.md')
    .sort((a, b) => a.entryName.length - b.entryName.length)

  if (skillMdEntries.length === 0) {
    throw new IpcErrorThrow('errors.skills.no_skill_md')
  }

  const skillMdEntry = skillMdEntries[0]
  // innerRoot = SKILL.md 所在目录（zip 内相对路径）
  const innerRoot = skillMdEntry.entryName.includes('/')
    ? skillMdEntry.entryName.slice(0, skillMdEntry.entryName.lastIndexOf('/'))
    : ''

  // 解析 SKILL.md
  const skillMdContent = skillMdEntry.getData().toString('utf8')
  const { fm, body } = parseFrontmatter(skillMdContent)

  // 技能名：frontmatter > overrideName > zip 文件名 > innerRoot 目录名
  const dirName = innerRoot ? basename(innerRoot) : ''
  const name = overrideName?.trim() || fm?.name || dirName || nameFromFilename(filePath)

  // 纪律段：frontmatter `discipline` 优先，回退正文 `## Discipline` 段落
  const fmDiscipline = typeof fm?.discipline === 'string' ? fm.discipline.trim() : ''
  const discipline = fmDiscipline || extractDisciplineSection(body)

  // 收集 resources 和 scripts
  const resources: string[] = []
  const scripts: string[] = []

  for (const entry of files) {
    if (entry.entryName === skillMdEntry.entryName) continue

    // 相对于 innerRoot 的路径
    let relPath = entry.entryName
    if (innerRoot) {
      if (!entry.entryName.startsWith(innerRoot + '/')) continue
      relPath = entry.entryName.slice(innerRoot.length + 1)
    }
    if (!relPath) continue

    // 分类：resources/ 或 scripts/ 目录
    const lowerPath = relPath.toLowerCase()
    if (lowerPath.startsWith('resources/') || lowerPath.startsWith('references/') || lowerPath.startsWith('assets/')) {
      resources.push(relPath)
    } else if (lowerPath.startsWith('scripts/')) {
      scripts.push(relPath)
    }
  }

  return {
    name,
    description: fm?.description?.trim() || fallbackDescription(body),
    content: body,
    discipline,
    resources: resources.length > 0 ? resources : undefined,
    scripts: scripts.length > 0 ? scripts : undefined,
  }
}

/**
 * 将 ZIP 包内的资源/脚本文件解压到指定 skill 目录。
 * 目录化改造：直接解压到 config/skills/<skillId>/，不再使用临时目录。
 */
export async function extractSkillResourcesToDir(
  filePath: string,
  targetDir: string,
  parsed: ParsedSkill,
): Promise<void> {
  if (!parsed.resources && !parsed.scripts) return

  await mkdir(targetDir, { recursive: true })

  const data = await readFile(filePath)
  const zip = new AdmZip(data)
  const entries = zip.getEntries()

  // 确定内根目录
  const skillMdEntry = entries.find(
    (e) => !e.isDirectory && basename(e.entryName).toLowerCase() === 'skill.md',
  )
  const innerRoot = skillMdEntry?.entryName.includes('/')
    ? skillMdEntry.entryName.slice(0, skillMdEntry.entryName.lastIndexOf('/'))
    : ''

  const allFiles = [...(parsed.resources ?? []), ...(parsed.scripts ?? [])]

  for (const relPath of allFiles) {
    const zipPath = innerRoot ? `${innerRoot}/${relPath}` : relPath
    const entry = zip.getEntry(zipPath)
    if (!entry || entry.isDirectory) continue

    const destPath = join(targetDir, relPath)
    // 路径穿越防护
    const expectedPrefix = targetDir + sep
    if (!destPath.startsWith(expectedPrefix) && destPath !== targetDir) {
      throw new Error(`路径穿越检测：${relPath}`)
    }

    // 写文件
    await mkdir(join(destPath, '..'), { recursive: true })
    await writeFile(destPath, entry.getData())
  }
}

/**
 * 上传技能包（解析 ZIP → 返回 ParsedSkill）。
 * 调用方负责 saveSkill 落盘 + extractSkillResourcesToDir 提取资源。
 */
export async function uploadSkillFile(
  filePath: string,
  overrideName?: string,
): Promise<ParsedSkill> {
  const ext = extname(filePath).toLowerCase()

  if (ext !== '.zip') {
    throw new IpcErrorThrow('errors.skills.zip_only')
  }

  return parseSkillZip(filePath, overrideName)
}
