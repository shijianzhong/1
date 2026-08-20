// —— 知识库摄取管线（docs/VECTOR_KB_PLAN.md §五）——
//
// 文本 → 分块 → 向量化 → 入库（kb_chunks + FTS 双写 + kb_docs 原文存档）。
// 不碰文件读取（上游/前端读完传 content 字符串进来，IPC 不持文件读权限）。
//
// 分块策略（方案 §五:152-168 + 用户确认「标准专业方案」）：
//   1. 剥 YAML frontmatter → 解析 {title?, tags?} 进每块 meta
//   2. 任意 `#` 标题行作切点 → 每个 section
//   3. section 超 maxTokens(512) → 按字符推进二次切，带 overlap(64) token 回退
//   4. code fence 守卫：块边界不落在 ``` 行内（回退到 fence 结束行）
//   5. frontmatter / 空文档兜底：分块异常 → 单块整文 meta 标 {fallback:true}
//
// 降级链（§四:144）：模型未就绪 → vec 全 NULL，content+FTS 照写；后续 reindex（P4）
// 经 listNullVecChunkIds + updateKbChunkVec 补齐。P1 只负责「写得让 reindex 能补回来」。
//
// e5 非对称：ingestion 传 'passage'（worker-embed.cjs 按 kind 加 "passage: " 前缀）。

import { randomUUID } from 'node:crypto'
import { approxTokenCount } from '../llm/token-count'
import { getLocalProvider, KB_MODEL_ID } from './embed'
import { insertKbChunks, upsertKbDoc, type KbChunkRecord } from './store'
import { logger } from '../logger'

/** 分块草稿（不含 vec/id，由 ingestDocument 补） */
export interface KbChunkDraft {
  content: string
  /** 所在标题（最近的 `#` 标题文本） */
  sectionTitle?: string
}

/** chunkDocument 的可调参数 */
export interface ChunkOptions {
  maxTokens?: number
  overlap?: number
}

const DEFAULT_MAX_TOKENS = 512
const DEFAULT_OVERLAP = 64

/**
 * 解析 YAML frontmatter（轻量：只取 title 与 tags，不引 js-yaml）。
 * frontmatter 形如 `---\ntitle: x\ntags: [a,b]\n---`。
 */
function parseFrontmatter(raw: string): { title?: string; tags?: string[] } {
  const out: { title?: string; tags?: string[] } = {}
  // 去掉首尾 --- 行后按行取
  const lines = raw.replace(/^---\s*\n/, '').replace(/\n---\s*$/, '').split('\n')
  for (const line of lines) {
    const m = line.match(/^\s*(\w+)\s*:\s*(.+?)\s*$/)
    if (!m) continue
    const [, key, val] = m
    if (key === 'title') {
      out.title = val.replace(/^["']|["']$/g, '')
    } else if (key === 'tags') {
      const arr = val.match(/\[([^\]]*)\]/)
      if (arr) out.tags = arr[1].split(',').map((t) => t.trim()).filter(Boolean)
    }
  }
  return out
}

/**
 * 剥离 frontmatter，返回 { body, fm }。
 * frontmatter = 文件首的 `^---\n...\n---` 块（容许首行空白后跟 ---）。
 */
function stripFrontmatter(content: string): { body: string; fm?: { title?: string; tags?: string[] } } {
  const m = content.match(/^\s*---\s*\n([\s\S]*?\n)---\s*\n?/)
  if (!m) return { body: content }
  return { body: content.slice(m[0].length), fm: parseFrontmatter(m[0]) }
}

/**
 * 二次切：单 section 超 maxTokens 时按行推进切窗口，带 overlap 回退。
 * 按行切（而非按字符）——避免拆断单词/中文，且便于 code fence 守卫。
 * overlap 是 token 数，保守按行回退直到累计 token 达 overlap（宁多勿少）。
 *
 * code fence 守卫：候选截断点若在 ```/~~~ fence 内，前进到 fence 结束行再切，
 * 不在 fence 中间硬切（防代码块断裂）。
 */
function splitByTokenWindow(text: string, maxTokens: number, overlap: number): string[] {
  const fenceRe = /^(\s*)(`{3,}|~{3,})/
  // 预切：单行超 maxTokens 时按 Unicode 码点拆成多个 ≤ maxTokens 片段（按行切不动单行）。
  // fence 行不拆（``` 行本身短；代码内容行若超长才拆——拆代码块是折中，优于不切丢尾部）。
  function splitLongLine(line: string): string[] {
    if (approxTokenCount(line) <= maxTokens) return [line]
    if (fenceRe.test(line)) return [line] // fence 标记行不拆
    const chars = Array.from(line)
    const out: string[] = []
    let s = 0
    while (s < chars.length) {
      let e = s
      while (e < chars.length && approxTokenCount(chars.slice(s, e + 1).join('')) <= maxTokens) e++
      if (e === s) e = s + 1 // 单字超 maxTokens 硬切
      out.push(chars.slice(s, e).join(''))
      s = e
    }
    return out
  }
  const lines = text.split('\n').flatMap(splitLongLine)
  const chunks: string[] = []
  let i = 0
  while (i < lines.length) {
    let j = i
    // 从 i 起取尽量多行直到达 maxTokens
    while (j < lines.length) {
      const next = lines.slice(i, j + 1).join('\n')
      if (approxTokenCount(next) > maxTokens && j > i) break
      j++
    }
    if (j === i) j = i + 1 // 单行就超 maxTokens——硬切该行
    // code fence 守卫：截断点 j 若在 fence 内 → 前进到 fence 关闭行
    let end = j
    let depth = 0
    for (let k = 0; k < end; k++) if (fenceRe.test(lines[k])) depth++
    if (depth % 2 === 1 && end < lines.length) {
      while (end < lines.length && !fenceRe.test(lines[end])) end++
      end++ // 含 fence 关闭行
    }
    chunks.push(lines.slice(i, end).join('\n'))
    if (end >= lines.length) break
    // 下窗口起点回退 overlap token（按行回退累计）；至少前进 1 行防死循环
    let back = 0
    let backTokens = 0
    while (back < end - i && backTokens < overlap) {
      backTokens += approxTokenCount(lines[end - 1 - back])
      back++
    }
    i = Math.max(i + 1, end - back)
  }
  return chunks.filter((c) => c.trim().length > 0)
}

/**
 * Markdown / 纯文本分块。
 * 按 `^#{1,6}\s` 标题切段 → 段超 maxTokens 二次切（带 overlap）→ code fence 守卫。
 */
export function chunkDocument(content: string, opts: ChunkOptions = {}): KbChunkDraft[] {
  if (!content || !content.trim()) return []
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS
  const overlap = opts.overlap ?? DEFAULT_OVERLAP

  const { body, fm } = stripFrontmatter(content)
  const lines = body.split('\n')

  const drafts: KbChunkDraft[] = []
  let currentTitle = fm?.title
  let sectionLines: string[] = []
  let inCodeFence = false
  const fenceRe = /^(\s*)(`{3,}|~{3,})/

  function flushSection(): void {
    const text = sectionLines.join('\n')
    sectionLines = []
    if (!text.trim()) return
    if (approxTokenCount(text) <= maxTokens) {
      drafts.push({ content: text, sectionTitle: currentTitle })
      return
    }
    // 二次切（overlap 回退 + code fence 守卫）
    const sub = splitByTokenWindow(text, maxTokens, overlap)
    for (const s of sub) drafts.push({ content: s, sectionTitle: currentTitle })
  }

  for (const line of lines) {
    // code fence 状态跟踪（``` 与 ~~~）：同一标记符再次出现即关闭
    if (fenceRe.test(line)) inCodeFence = !inCodeFence
    // 标题行作切点（仅当不在 code fence 内 —— fence 内的 `#` 是注释/内容）
    if (!inCodeFence && /^#{1,6}\s/.test(line)) {
      flushSection()
      currentTitle = line.replace(/^#{1,6}\s+/, '').trim() || currentTitle
      sectionLines.push(line) // 标题行进下一 section
      continue
    }
    sectionLines.push(line)
  }
  flushSection()

  // frontmatter title 进首块 meta（已作 currentTitle 初值）；tags 暂不入 chunk（P2 再用）
  return drafts
}

/** ingestDocument 入参 */
export interface IngestInput {
  title: string
  content: string
  sourceKind?: string
  sourcePath?: string
  /** 传则覆盖重摄取同 doc；不传则生成新 kb_doc_{uuid} */
  docId?: string
  signal?: AbortSignal
}

/** ingestDocument 返回统计 */
export interface IngestResult {
  docId: string
  chunkCount: number
  embedded: number
  nullVec: number
}

/**
 * 摄取一篇文章：分块 → 向量化 → 入库。
 * 绝不抛（embed 失败已由 worker-client catch 成 null 降级；分块失败兜底单块整文）。
 */
export async function ingestDocument(input: IngestInput): Promise<IngestResult> {
  const docId = input.docId ?? `kb_doc_${randomUUID()}`
  const content = input.content ?? ''

  // 分块（失败兜底单块整文）
  let drafts: KbChunkDraft[]
  try {
    drafts = chunkDocument(content)
  } catch (e) {
    logger.warn('[kb-pipeline] chunkDocument 异常，降级单块整文', e)
    drafts = [{ content, sectionTitle: undefined }]
  }
  // 空文档：不写空 doc（返回零计数，调用方据此判空）
  if (drafts.length === 0) {
    return { docId, chunkCount: 0, embedded: 0, nullVec: 0 }
  }

  // 向量化（降级：provider 未就绪 → 全 null，content+FTS 照写）
  const texts = drafts.map((d) => d.content)
  const provider = getLocalProvider()
  let vecs: (Float32Array | null)[]
  const ready = await provider.ready().catch(() => false)
  if (ready) {
    vecs = await provider.embed(texts, input.signal, 'passage') // e5 ingestion 传 passage
  } else {
    logger.warn(
      `[kb-pipeline] provider 未就绪，doc ${docId} 块 vec=NULL 降级写入（reindex 补齐）`,
    )
    vecs = texts.map(() => null)
  }

  // 组 KbChunkRecord[]（kbId=docId 同值，P0 约定简化索引）
  const records: KbChunkRecord[] = drafts.map((d, i) => ({
    kbId: docId,
    docId,
    chunkIdx: i,
    content: d.content,
    vec: vecs[i] ?? null,
    meta: JSON.stringify({
      docTitle: input.title,
      sectionTitle: d.sectionTitle ?? null,
      chunkIdx: i,
      source: input.sourcePath ?? null,
    }),
  }))

  // 入库：chunks+fts 双写（先删旧块幂等）+ kb_docs 原文存档
  insertKbChunks(records)
  upsertKbDoc({
    id: docId,
    title: input.title,
    content,
    sourcePath: input.sourcePath ?? null,
    sourceKind: input.sourceKind ?? null,
    chunks: records.length,
    embeddingProvider: KB_MODEL_ID,
  })

  const embedded = vecs.filter((v) => v != null).length
  return {
    docId,
    chunkCount: records.length,
    embedded,
    nullVec: records.length - embedded,
  }
}
