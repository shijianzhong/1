import type { RegistryProvenance } from '@shared/types'

// —— SKILL.md 解析与构建（目录化标准格式，docs/SKILL_STORAGE_STANDARD_PLAN.md §四）——
// frontmatter(name/description/discipline/registry_*) + 正文 content。
// 读取时允许 frontmatter discipline 和正文 ## Discipline 两种写法（读宽写严）；
// 写回时统一写成 ## Discipline 段落（frontmatter 不写 discipline 字段）。

export interface ParsedSkillMd {
  name: string
  description?: string
  content: string
  /** 输出纪律段（frontmatter `discipline` 优先，回退 `## Discipline` 段落） */
  discipline?: string
  /** registry provenance（frontmatter `registry_*` 字段） */
  registry?: RegistryProvenance
  /** 从 zip 中提取的资源文件相对路径列表（仅 parseSkillZip 使用） */
  resources?: string[]
  /** 从 zip 中提取的脚本文件相对路径列表（仅 parseSkillZip 使用） */
  scripts?: string[]
}

interface Frontmatter {
  name?: string
  description?: string
  [key: string]: unknown
}

/** 解析 YAML frontmatter（简易版，不引入额外依赖；索引步进避免重复行误判） */
export function parseFrontmatter(text: string): { fm: Frontmatter | null; body: string } {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  if (!match) return { fm: null, body: text }

  const lines = match[1].split('\n')
  const body = match[2]
  const fm: Frontmatter = {}

  let i = 0
  while (i < lines.length) {
    const trimmed = lines[i].trim()
    i++
    if (!trimmed || trimmed.startsWith('#')) continue
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx === -1) continue
    const key = trimmed.slice(0, colonIdx).trim()
    let value = trimmed.slice(colonIdx + 1).trim()
    if (!key) continue

    // 块标量：| 字面（保留换行）/ > 折叠（空格连接）——取后续缩进行
    if (value === '|' || value === '>') {
      const folded = value === '>'
      const block: string[] = []
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i].startsWith('\t'))) {
        block.push(lines[i].trim())
        i++
      }
      value = folded ? block.join(' ') : block.join('\n')
    } else {
      // 去引号（双引号配套反转义 \" \\——与导出侧 yamlSafe 回环保真）
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1).replace(/\\(["\\])/g, '$1')
      } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1)
      } else {
        // 行内注释（空格 + # 起始才算，值内 # 保留）
        const hashIdx = value.indexOf(' #')
        if (hashIdx !== -1) value = value.slice(0, hashIdx).trim()
      }
    }
    fm[key as keyof Frontmatter] = value
  }

  return { fm, body: body.trim() }
}

/**
 * 从 SKILL.md 正文提取 `## Discipline` 段落（到下一个二级标题或文末为止）。
 * 注意不从 content 剥离该段：content 是唯一注入载体，剥离会让纪律段从 prompt 消失。
 */
export function extractDisciplineSection(body: string): string | undefined {
  const lines = body.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+discipline\s*$/i.test(lines[i].trim())) {
      start = i + 1
      break
    }
  }
  if (start === -1) return undefined
  const collected: string[] = []
  for (let i = start; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break
    collected.push(lines[i])
  }
  const text = collected.join('\n').trim()
  return text || undefined
}

function fallbackDescription(body: string): string | undefined {
  const text = body.replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, 120) : undefined
}

/** 解析 SKILL.md 文本为结构化对象（frontmatter + 正文） */
export function parseSkillMd(text: string): ParsedSkillMd | null {
  const { fm, body } = parseFrontmatter(text)
  const name = typeof fm?.name === 'string' ? fm.name.trim() : ''
  if (!name) return null

  const fmDiscipline = typeof fm?.discipline === 'string' ? fm.discipline.trim() : ''
  const discipline = fmDiscipline || extractDisciplineSection(body) || undefined

  // registry provenance from frontmatter
  const registryId = typeof fm?.registry_id === 'string' ? fm.registry_id.trim() : ''
  const registryVersion = typeof fm?.registry_version === 'string' ? fm.registry_version.trim() : ''
  const registry: RegistryProvenance | undefined = registryId
    ? {
        registryId,
        version: registryVersion || '0.0.0',
        author: typeof fm?.registry_author === 'string' ? fm.registry_author.trim() : undefined,
        importedAt: typeof fm?.registry_imported_at === 'number'
          ? fm.registry_imported_at
          : typeof fm?.registry_imported_at === 'string'
            ? Number(fm.registry_imported_at) || 0
            : 0,
      }
    : undefined

  return {
    name,
    description: fm?.description?.trim() || undefined,
    content: body,
    discipline,
    registry,
  }
}

/**
 * YAML 特殊字符值加双引号包裹（`:`/`#`/换行/引号/括号会破坏 frontmatter 解析；
 * 与 parseFrontmatter 的去引号 + 双引号反转义配套，保证导出→导入回环保真）。
 */
export function yamlSafe(s: string): string {
  return /[:#\n"'[\]{}]/.test(s)
    ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : s
}

/**
 * 构建 SKILL.md 文本：frontmatter(name/description/registry_*) + content 原文。
 * discipline 已在 content 的 `## Discipline` 段时原样保留；仅在 discipline 字段存在而
 * content 缺段时补段（防用户在管理页只编辑了 discipline 字段导致导出丢失）。
 */
export function buildSkillMd(skill: {
  name: string
  description?: string
  content: string
  discipline?: string
  registry?: RegistryProvenance
}): string {
  const fm: string[] = ['---', `name: ${yamlSafe(skill.name)}`]
  if (skill.description) fm.push(`description: ${yamlSafe(skill.description)}`)
  if (skill.registry) {
    fm.push(`registry_id: ${skill.registry.registryId}`)
    fm.push(`registry_version: ${skill.registry.version}`)
    if (skill.registry.author) fm.push(`registry_author: ${yamlSafe(skill.registry.author)}`)
    fm.push(`registry_imported_at: ${skill.registry.importedAt}`)
  }
  fm.push('---')
  let body = skill.content.trimEnd()
  if (skill.discipline && !extractDisciplineSection(body)) {
    body += `\n\n## Discipline\n\n${skill.discipline.trim()}`
  }
  return fm.join('\n') + '\n\n' + body + '\n'
}
