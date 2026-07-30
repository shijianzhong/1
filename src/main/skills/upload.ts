import AdmZip from 'adm-zip'
import { readFile } from 'node:fs/promises'
import { basename, extname, join, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { getSkillsPath } from '../storage/paths'

// —— 技能包上传与导入（借鉴 Proton skills_mgmt + agent-framework ArchiveEntryLoader）——
// 仅支持 .zip 格式：
//   .zip → 压缩包，查找 SKILL.md，解析 frontmatter，正文为 content
//          resources/ 和 scripts/ 子目录写入 userData/config/skills/{id}/
// 路径穿越防护：所有解压路径必须落在目标目录内。

const MAX_ARCHIVE_SIZE = 10 * 1024 * 1024 // 10MB
const MAX_FILE_COUNT = 200

export interface ParsedSkill {
  name: string
  description?: string
  content: string
  /** 从 zip 中提取的资源文件相对路径列表 */
  resources?: string[]
  /** 从 zip 中提取的脚本文件相对路径列表 */
  scripts?: string[]
}

interface Frontmatter {
  name?: string
  description?: string
  [key: string]: unknown
}

/** 解析 YAML frontmatter（简易版，不引入额外依赖） */
function parseFrontmatter(text: string): { fm: Frontmatter | null; body: string } {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  if (!match) return { fm: null, body: text }

  const yamlBlock = match[1]
  const body = match[2]
  const fm: Frontmatter = {}

  for (const line of yamlBlock.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx === -1) continue
    const key = trimmed.slice(0, colonIdx).trim()
    let value = trimmed.slice(colonIdx + 1).trim()
    // 去引号
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    // 支持 > 块引用描述
    if (value === '>' || value === '|') {
      // 多行值：取后续缩进行
      const lines = yamlBlock.split('\n')
      const currentIdx = lines.indexOf(line)
      const multiLines: string[] = []
      for (let i = currentIdx + 1; i < lines.length; i++) {
        if (lines[i].startsWith('  ') || lines[i].startsWith('\t')) {
          multiLines.push(lines[i].trim())
        } else {
          break
        }
      }
      value = multiLines.join(' ')
    }
    if (key) fm[key as keyof Frontmatter] = value
  }

  return { fm, body: body.trim() }
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
    throw new Error('ZIP 内未找到 SKILL.md')
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
    description: fm?.description,
    content: body,
    resources: resources.length > 0 ? resources : undefined,
    scripts: scripts.length > 0 ? scripts : undefined,
  }
}

/**
 * 将 ZIP 包内的资源/脚本文件解压到 userData/config/skills/{skillId}/ 目录。
 * 仅在有 resources/scripts 时调用。
 */
export async function extractSkillResources(
  filePath: string,
  skillId: string,
  parsed: ParsedSkill,
): Promise<{ resourceDir?: string; scriptPath?: string }> {
  if (!parsed.resources && !parsed.scripts) return {}

  const targetDir = join(getSkillsPath(), skillId)
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
  let scriptPath: string | undefined
  let resourceDir: string | undefined

  for (const relPath of allFiles) {
    const zipPath = innerRoot ? `${innerRoot}/${relPath}` : relPath
    const entry = zip.getEntry(zipPath)
    if (!entry || entry.isDirectory) continue

    const destPath = join(targetDir, relPath)
    // 路径穿越防护
    const resolvedDest = destPath
    const expectedPrefix = targetDir + sep
    if (!resolvedDest.startsWith(expectedPrefix) && resolvedDest !== targetDir) {
      throw new Error(`路径穿越检测：${relPath}`)
    }

    // 写文件
    await mkdir(join(resolvedDest, '..'), { recursive: true })
    await writeFile(resolvedDest, entry.getData())

    // 记录脚本路径
    if (relPath.startsWith('scripts/') && !scriptPath) {
      scriptPath = resolvedDest
    }
    if (relPath.startsWith('resources/') && !resourceDir) {
      resourceDir = join(targetDir, 'resources')
    }
  }

  return { resourceDir, scriptPath }
}

/**
 * 上传技能包（主入口）。
 * @param filePath 用户选择的 ZIP 文件路径
 * @param overrideName 可选覆盖名称
 * @returns ParsedSkill（调用方负责 saveSkill 落盘）
 */
export async function uploadSkillFile(
  filePath: string,
  overrideName?: string,
): Promise<{ parsed: ParsedSkill; resourceDir?: string; scriptPath?: string }> {
  const ext = extname(filePath).toLowerCase()

  if (ext !== '.zip') {
    throw new Error('仅支持 .zip 格式的技能包（ZIP 内须包含 SKILL.md）')
  }

  const parsed = await parseSkillZip(filePath, overrideName)
  // 如果有 resources/scripts，解压到独立目录
  if (parsed.resources || parsed.scripts) {
    const tempId = `skl_upload_${randomUUID().slice(0, 8)}`
    const { resourceDir, scriptPath } = await extractSkillResources(filePath, tempId, parsed)
    return { parsed, resourceDir, scriptPath }
  }
  return { parsed }
}
