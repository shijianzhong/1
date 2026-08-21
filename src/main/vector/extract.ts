// —— 文档抽取（docs/VECTOR_KB_PLAN.md §八 P5）——
//
// 把 pdf/docx/txt/md/URL → { content: markdown, title?, sourceKind }。
// content 喂给 ingestDocument（pipeline.ts），其 chunkDocument 按 `#` 标题切段 →
// 这里发射的 `#` 标题会变成 chunk meta.sectionTitle（检索可按章节定位）。
//
// 边界（同 pipeline.ts:4「不碰文件读取」）：extract 负责读文件 + 抽取成 content 字符串，
// ingestDocument 仍 file-read-free。extract 不 import ingestDocument——IPC handler 组合两者。
//
// 线程模型：主进程内 async 抽取（unpdf 文本解析 / mammoth 流式 XML / URL 网络 I/O，
// 均非 WASM 推理，比 embedding 轻；只有 embedding offload 到 spawn worker）。
// 防病态 PDF 阻塞：size guard > MAX_FILE_BYTES → errors:kb.file_too_large。
//
// unpdf/mammoth 懒加载（await import）保启动精简，仅 kb:pickFile/kb:add(url) 路径才加载。
//
// 错误一律 IpcErrorThrow('errors:kb.*')，不硬编码中文（铁律 T2）。

import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { IpcErrorThrow } from '@shared/types'
import { logger } from '../logger'
import { fetchWithTimeout } from '../util/net'
import { stripTags, decodeEntities } from '../util/html'

/** 抽取结果——content 为 markdown，喂 ingestDocument */
export interface ExtractedDoc {
  content: string
  title?: string
  sourceKind: 'pdf' | 'docx' | 'txt' | 'md' | 'url'
}

/** 文件大小上限（20MB）——防病态 PDF 阻塞主进程抽取 */
const MAX_FILE_BYTES = 20 * 1024 * 1024

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const URL_TIMEOUT_MS = 30_000
const URL_CAP = 12_000

/**
 * 从文件抽取文本（markdown）。
 * - .pdf → unpdf 每页文本，页间插 `# Page N`（让 chunkDocument 产出 per-page sectionTitle）
 * - .docx → mammoth.convertToMarkdown（内置 Heading1→`#` 映射）
 * - .txt/.md → 原文（md 自带 heading；txt 无——flat chunking 可接受）
 */
export async function extractFromFile(filePath: string): Promise<ExtractedDoc> {
  // size guard：先 stat，防读完大文件才报错或阻塞
  let size: number
  try {
    size = statSync(filePath).size
  } catch {
    throw new IpcErrorThrow('errors:kb.extract_failed', 'stat failed')
  }
  if (size > MAX_FILE_BYTES) {
    throw new IpcErrorThrow('errors:kb.file_too_large', String(MAX_FILE_BYTES / (1024 * 1024)))
  }

  const ext = filePath.toLowerCase().split('.').pop() ?? ''
  const title = basename(filePath)

  if (ext === 'pdf') {
    return { content: await extractPdf(filePath), title, sourceKind: 'pdf' }
  }
  if (ext === 'docx') {
    const content = await extractDocx(filePath)
    if (!content.trim()) throw new IpcErrorThrow('errors:kb.empty_extraction')
    return { content, title: firstHeading(content) ?? title, sourceKind: 'docx' }
  }
  if (ext === 'html' || ext === 'htm') {
    let raw: string
    try {
      raw = readFileSync(filePath, 'utf8')
    } catch (e) {
      throw new IpcErrorThrow('errors:kb.extract_failed', (e as Error).message)
    }
    const content = htmlToMarkdown(raw).trim()
    if (!content) throw new IpcErrorThrow('errors:kb.empty_extraction')
    return { content, title: firstHeading(content) ?? title, sourceKind: 'txt' }
  }
  if (ext === 'txt' || ext === 'md') {
    let raw: string
    try {
      raw = readFileSync(filePath, 'utf8')
    } catch (e) {
      throw new IpcErrorThrow('errors:kb.extract_failed', (e as Error).message)
    }
    if (!raw.trim()) throw new IpcErrorThrow('errors:kb.empty_extraction')
    return { content: raw, title, sourceKind: ext === 'md' ? 'md' : 'txt' }
  }
  throw new IpcErrorThrow('errors:kb.unsupported_file_type', ext)
}

/** PDF → 每页文本，页间插 `# Page N` */
async function extractPdf(filePath: string): Promise<string> {
  let buf: Buffer
  try {
    buf = readFileSync(filePath)
  } catch (e) {
    throw new IpcErrorThrow('errors:kb.extract_failed', (e as Error).message)
  }
  // 懒加载：unpdf 带 PDF.js WASM，仅 PDF 路径才加载
  const { extractText } = await import('unpdf')
  let pages: string[]
  try {
    const res = await extractText(buf, { mergePages: false })
    // extractText 返 { totalPages, text: string[] }（mergePages:false = 每页一字符串）
    pages = Array.isArray(res.text) ? res.text : [res.text as unknown as string]
  } catch (e) {
    logger.warn('[kb-extract] PDF 抽取失败', e)
    throw new IpcErrorThrow('errors:kb.extract_failed', (e as Error).message)
  }
  const nonEmpty = pages.filter((p) => (p ?? '').trim().length > 0)
  if (nonEmpty.length === 0) throw new IpcErrorThrow('errors:kb.empty_extraction')
  // 每页前插 `# Page N` 标题 → chunkDocument 产 per-page sectionTitle
  return nonEmpty.map((p, i) => `# Page ${i + 1}\n${p.trim()}`).join('\n\n')
}

/** DOCX → mammoth.convertToHtml（Heading1→`<h1>` 默认映射）→ htmlToMarkdown */
async function extractDocx(filePath: string): Promise<string> {
  let buf: Buffer
  try {
    buf = readFileSync(filePath)
  } catch (e) {
    throw new IpcErrorThrow('errors:kb.extract_failed', (e as Error).message)
  }
  const { convertToHtml } = await import('mammoth')
  try {
    const res = await convertToHtml({ buffer: buf })
    return htmlToMarkdown(res.value ?? '')
  } catch (e) {
    logger.warn('[kb-extract] DOCX 抽取失败', e)
    throw new IpcErrorThrow('errors:kb.extract_failed', (e as Error).message)
  }
}

/**
 * HTML → Markdown（手写，不引 turndown）。
 * 覆盖标题/段落/列表/链接/强调/代码/pre 块——docx/HTML 摄取够用。
 * 不做完整 HTML 解析（无 DOM），用正则剥标签 + 映射常见块，防 XSS 不涉及（纯文本化）。
 */
export function htmlToMarkdown(html: string): string {
  if (!html) return ''
  let s = html
  // 块级映射（成对标签）
  s = s.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, t) => `\n# ${stripTags(t).trim()}\n`)
  s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, t) => `\n## ${stripTags(t).trim()}\n`)
  s = s.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, t) => `\n### ${stripTags(t).trim()}\n`)
  s = s.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_, t) => `\n#### ${stripTags(t).trim()}\n`)
  s = s.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, (_, t) => `\n##### ${stripTags(t).trim()}\n`)
  s = s.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, (_, t) => `\n###### ${stripTags(t).trim()}\n`)
  // pre / code 块（保留原文）
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, t) => `\n\`\`\`\n${stripTags(t).trim()}\n\`\`\`\n`)
  // ul/ol 列表（含嵌套，review #7）：非贪婪 `([\s\S]*?)` 直匹配嵌套列表会切到
  // 内层第一个 </ul>，层级错位（docx 多级列表常见）。改为反复替换「最内层列表」
  // （内容不再含任何 ul/ol 开闭标签），内层先转成 markdown 文本、外层后转，迭代至
  // 收敛；cap 20 防病态 HTML 死循环。嵌套缩进不保留（平铺），但条目不粘连、不丢前缀。
  const innermostListRe = /<(ul|ol)[^>]*>((?:(?!<\/?(?:ul|ol)\b)[\s\S])*?)<\/\1>/gi
  for (let iter = 0; iter < 20; iter++) {
    let changed = false
    s = s.replace(innermostListRe, (_m, tag: string, inner: string) => {
      changed = true
      let n = 1
      const ordered = tag.toLowerCase() === 'ol'
      return (
        inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_l: string, t: string) =>
          ordered ? `\n${n++}. ${stripTags(t).trim()}` : `\n- ${stripTags(t).trim()}`,
        ) + '\n'
      )
    })
    if (!changed) break
  }
  // 行内映射
  s = s.replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, t) => `[${stripTags(t).trim()}](${href})`)
  s = s.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, (_, t) => `**${stripTags(t)}**`)
  s = s.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, (_, t) => `**${stripTags(t)}**`)
  s = s.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, (_, t) => `*${stripTags(t)}*`)
  s = s.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, (_, t) => `*${stripTags(t)}*`)
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, t) => `\`${stripTags(t)}\``)
  // <br> / <p> → 换行
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/p>/gi, '\n\n')
  // 剥余标签
  s = stripTags(s)
  // 解码实体（共享 decodeEntities 全量表：named + decimal + hex，review #11）+ 收敛空行
  s = decodeEntities(s)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return s
}

/**
 * 从 URL 抓取正文（Jina Reader r.jina.ai，返 markdown）。
 * 超时 + signal 链接走共享 fetchWithTimeout（util/net.ts，与 web.ts 同源，review #10）。
 * JINA_API_KEY 只在主进程读 process.env（铁律3：secrets 不入渲染层）。
 */
export async function extractFromUrl(url: string, signal?: AbortSignal): Promise<ExtractedDoc> {
  if (!/^https?:\/\//.test(url)) {
    throw new IpcErrorThrow('errors:kb.url_fetch_failed', 'invalid url')
  }
  const key = process.env.JINA_API_KEY
  let text: string
  try {
    const res = await fetchWithTimeout(`https://r.jina.ai/${url}`, {
      timeoutMs: URL_TIMEOUT_MS,
      signal,
      headers: {
        'User-Agent': UA,
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
    })
    if (!res.ok) {
      throw new IpcErrorThrow('errors:kb.url_fetch_failed', `http_${res.status}`)
    }
    text = await res.text()
  } catch (e) {
    if (e instanceof IpcErrorThrow) throw e
    throw new IpcErrorThrow('errors:kb.url_fetch_failed', (e as Error).message)
  }
  const content = text.slice(0, URL_CAP).trim()
  if (!content) throw new IpcErrorThrow('errors:kb.empty_extraction')
  return {
    content,
    title: firstHeading(content) ?? hostnameOf(url),
    sourceKind: 'url',
  }
}

/** 取 markdown 首个 `#` 标题文本，无则 undefined */
function firstHeading(md: string): string | undefined {
  const m = md.match(/^#{1,6}\s+(.+?)\s*$/m)
  return m?.[1]?.trim() || undefined
}

/** URL → hostname（失败回退原 url 串） */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
