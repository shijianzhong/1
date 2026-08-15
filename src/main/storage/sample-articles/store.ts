import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseFrontmatter, yamlSafe } from '../skills/parser'
import type { SampleArticle } from '@shared/types'
import { getSampleArticlesPath } from '../paths'
import { generateId } from '../json-store'
import { logger } from '../../logger'

// —— 样文目录化存储（docs/CONTENT_PIPELINE_PLAN.md §2.3）——
// 磁盘事实：config/sample-articles/<id>/ARTICLE.md + references/ + meta
// 运行时投影：扫描目录 → SampleArticle 对象
// builtin 基线经 seedBuiltinAssets 复制进 userData（§2.5），用户可改可分享。

/** 获取样文根目录（config/sample-articles/<id>） */
export function getSampleArticleDir(id: string): string {
  return join(getSampleArticlesPath(), id)
}

/** 检测目录是否有 references/ 子目录且非空 */
function hasReferencesInDir(dir: string): boolean {
  const refDir = join(dir, 'references')
  if (!existsSync(refDir)) return false
  try {
    return readdirSync(refDir, { withFileTypes: true }).some((e) => e.isFile())
  } catch {
    return false
  }
}

/** 计算文章字数（中文按字，英文按词，近似） */
function countWords(text: string): number {
  // 去 frontmatter + markdown 符号，中文字符逐个计、英文按空格分词
  const cleaned = text.replace(/[#*`>\-]/g, ' ').replace(/\s+/g, ' ').trim()
  const cjk = (cleaned.match(/[一-龥]/g) ?? []).length
  const words = cleaned.replace(/[一-龥]/g, '').trim().split(/\s+/).filter(Boolean).length
  return cjk + words
}

/** 扫描单个样文目录 → SampleArticle 对象；无 ARTICLE.md 返回 null */
function scanSampleArticleDir(dir: string): SampleArticle | null {
  const articlePath = join(dir, 'ARTICLE.md')
  if (!existsSync(articlePath)) return null

  let text: string
  try {
    text = readFileSync(articlePath, 'utf8')
  } catch {
    return null
  }

  const { fm, body } = parseFrontmatter(text)
  const name = typeof fm?.name === 'string' ? fm.name.trim() : ''
  if (!name) return null

  const tagsRaw = fm?.tags
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw.map((t) => String(t).trim()).filter(Boolean)
    : typeof tagsRaw === 'string'
      ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean)
      : undefined

  let stat: { mtimeMs: number; birthtimeMs: number }
  try {
    const s = statSync(articlePath)
    stat = { mtimeMs: s.mtimeMs, birthtimeMs: s.birthtimeMs }
  } catch {
    stat = { mtimeMs: 0, birthtimeMs: 0 }
  }

  const id = basename(dir)
  return {
    id,
    name,
    description: typeof fm?.description === 'string' ? fm.description.trim() : undefined,
    content: body,
    source: typeof fm?.source === 'string' ? fm.source.trim() : undefined,
    tags: tags && tags.length > 0 ? tags : undefined,
    hasReferences: hasReferencesInDir(dir),
    wordCount: countWords(body),
    createdAt: stat.birthtimeMs || stat.mtimeMs,
    updatedAt: stat.mtimeMs,
  }
}

// —— 缓存（仿 skills/store.ts）——
let cache: SampleArticle[] | null = null

export function invalidateSampleArticlesCache(): void {
  cache = null
}

function getCached(): SampleArticle[] {
  if (cache) return cache
  const dir = getSampleArticlesPath()
  if (!existsSync(dir)) {
    cache = []
    return cache
  }
  const articles: SampleArticle[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const article = scanSampleArticleDir(join(dir, entry.name))
    if (article) articles.push(article)
  }
  articles.sort((a, b) => b.updatedAt - a.updatedAt)
  cache = articles
  return cache
}

// —— 对外 API ——

export function listSampleArticles(): SampleArticle[] {
  return getCached()
}

export function getSampleArticle(id: string): SampleArticle | null {
  const dir = getSampleArticleDir(id)
  if (!existsSync(dir)) return null
  return scanSampleArticleDir(dir)
}

export function saveSampleArticle(input: {
  id?: string
  name: string
  description?: string
  content: string
  source?: string
  tags?: string[]
}): SampleArticle {
  const id = input.id ?? generateId('art_')
  const dir = getSampleArticleDir(id)
  const existing = existsSync(dir) ? scanSampleArticleDir(dir) : null
  const now = Date.now()

  const article: SampleArticle = {
    id,
    name: input.name,
    description: input.description,
    content: input.content,
    source: input.source,
    tags: input.tags,
    hasReferences: existing?.hasReferences ?? false,
    wordCount: countWords(input.content),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }

  mkdirSync(dir, { recursive: true })
  // 构建 ARTICLE.md：frontmatter(name/description/source/tags) + 正文
  const fmLines: string[] = ['---', `name: ${yamlSafe(input.name)}`]
  if (input.description) fmLines.push(`description: ${yamlSafe(input.description)}`)
  if (input.source) fmLines.push(`source: ${yamlSafe(input.source)}`)
  if (input.tags && input.tags.length > 0) {
    fmLines.push('tags:')
    for (const tag of input.tags) fmLines.push(`  - ${yamlSafe(tag)}`)
  }
  fmLines.push('---')
  writeFileSync(join(dir, 'ARTICLE.md'), fmLines.join('\n') + '\n\n' + input.content.trimEnd() + '\n', 'utf8')

  const refreshed = scanSampleArticleDir(dir)
  cache = null
  return refreshed ?? article
}

export function removeSampleArticle(id: string): void {
  const dir = getSampleArticleDir(id)
  rmSync(dir, { recursive: true, force: true })
  cache = null
  logger.info(`[sample-articles] 已删除样文目录 ${id}`)
}
