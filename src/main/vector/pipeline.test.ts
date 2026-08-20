import { beforeEach, describe, expect, it, vi } from 'vitest'

// —— pipeline.ts 单测（分块逻辑为主，ingest 走 mock 验 ready 两态）——
// mock getActiveProvider（不真跑 WASM worker）+ insertKbChunks/upsertKbDoc（不真写库）。
// chunkDocument 是纯函数，直接断言分块结果。

const embedMock = vi.fn()
const readyMock = vi.fn()
vi.mock('./embed', () => ({
  getActiveProvider: () => ({
    kind: 'local',
    ready: readyMock,
    dimension: () => 384,
    embed: embedMock,
  }),
  KB_MODEL_ID: 'Xenova/multilingual-e5-small',
}))
const insertKbChunksMock = vi.fn((records: unknown[]) => records.map((_, i) => `kb_${i}`))
const upsertKbDocMock = vi.fn()
vi.mock('./store', () => ({
  insertKbChunks: insertKbChunksMock,
  upsertKbDoc: upsertKbDocMock,
}))

const { chunkDocument, ingestDocument } = await import('./pipeline')

beforeEach(() => {
  embedMock.mockReset()
  readyMock.mockReset()
  insertKbChunksMock.mockClear()
  upsertKbDocMock.mockClear()
})

describe('chunkDocument', () => {
  it('空文档/纯空白 → 空数组', () => {
    expect(chunkDocument('')).toEqual([])
    expect(chunkDocument('   \n  \t ')).toEqual([])
  })

  it('frontmatter 剥离 + title 进 sectionTitle', () => {
    const md = `---
title: 我的文档
tags: [a, b]
---
# 第一章
正文内容`
    const drafts = chunkDocument(md)
    expect(drafts.length).toBeGreaterThanOrEqual(1)
    // frontmatter 不应出现在分块内容里
    expect(drafts.some((d) => d.content.includes('---'))).toBe(false)
    // 第一个 `#` 标题进 sectionTitle（frontmatter title 不是分块标题，进 meta 由 ingestDocument 拼）
    expect(drafts[0].sectionTitle).toBe('第一章')
  })

  it('多 # 标题分段', () => {
    const md = `# A
内容A
# B
内容B
### C
内容C`
    const drafts = chunkDocument(md)
    // 至少 3 段（每标题一段）
    expect(drafts.length).toBeGreaterThanOrEqual(3)
    const titles = drafts.map((d) => d.sectionTitle)
    expect(titles).toContain('A')
    expect(titles).toContain('B')
    expect(titles).toContain('C')
  })

  it('超 maxTokens section 二次切 + 不少于 2 块', () => {
    // 构造一个远超 maxTokens 的长段（无标题打断）
    const long = '这是一段很长的正文。'.repeat(200) // ~2000 字 ≈ 1300 token > 512
    const drafts = chunkDocument(long, { maxTokens: 512, overlap: 64 })
    expect(drafts.length).toBeGreaterThan(1)
    // 每块都不应含标题（无标题输入）
    for (const d of drafts) expect(d.content.includes('#')).toBe(false)
  })

  it('code fence 不被拦腰截断（块边界不落在 fence 内）', () => {
    // 构造：标题 + 一个超长 code fence（```\n 1000 行代码 \n```）
    const code = 'const x = 1\n'.repeat(200) // 足够长触发二次切
    const md = `# Code Section
\`\`\`js
${code}\`\`\`
# After`
    const drafts = chunkDocument(md, { maxTokens: 512, overlap: 64 })
    expect(drafts.length).toBeGreaterThan(1)
    // 每块若含 ```，则开头或结尾 fence 标记数应为偶数（成对），不在 fence 中间断
    // 简单断言：任一含 ``` 的块，其 ``` 出现次数为偶数
    for (const d of drafts) {
      const fences = (d.content.match(/```/g) || []).length
      if (fences > 0) expect(fences % 2).toBe(0)
    }
  })
})

describe('ingestDocument', () => {
  it('provider 就绪 → embed 传 passage + 全 embedded', async () => {
    readyMock.mockResolvedValue(true)
    embedMock.mockResolvedValue([
      Float32Array.from([0.1, 0.2]),
      Float32Array.from([0.3, 0.4]),
    ])
    const r = await ingestDocument({
      title: 't',
      content: '# A\n正文1\n# B\n正文2',
    })
    expect(r.chunkCount).toBe(2)
    expect(r.embedded).toBe(2)
    expect(r.nullVec).toBe(0)
    // embed 收到 kind='passage'（e5 ingestion）
    expect(embedMock).toHaveBeenCalledWith(
      expect.any(Array),
      undefined,
      'passage',
    )
    // insertKbChunks + upsertKbDoc 各调一次
    expect(insertKbChunksMock).toHaveBeenCalledTimes(1)
    expect(upsertKbDocMock).toHaveBeenCalledTimes(1)
    // upsert 带 content 原文
    const upsertArg = upsertKbDocMock.mock.calls[0][0]
    expect(upsertArg.content).toBe('# A\n正文1\n# B\n正文2')
  })

  it('provider 未就绪 → vec 全 null 降级 + nullVec=chunkCount', async () => {
    readyMock.mockResolvedValue(false)
    const r = await ingestDocument({
      title: 't',
      content: '# A\n正文1\n# B\n正文2',
    })
    expect(r.chunkCount).toBe(2)
    expect(r.embedded).toBe(0)
    expect(r.nullVec).toBe(2)
    // 未就绪不调 embed
    expect(embedMock).not.toHaveBeenCalled()
    // content/fts 仍写
    expect(insertKbChunksMock).toHaveBeenCalledTimes(1)
    expect(upsertKbDocMock).toHaveBeenCalledTimes(1)
  })

  it('空 content → chunkCount=0 不写库', async () => {
    readyMock.mockResolvedValue(true)
    const r = await ingestDocument({ title: 't', content: '   ' })
    expect(r.chunkCount).toBe(0)
    expect(insertKbChunksMock).not.toHaveBeenCalled()
    expect(upsertKbDocMock).not.toHaveBeenCalled()
  })

  it('docId 传则覆盖重摄取（幂等）', async () => {
    readyMock.mockResolvedValue(false)
    const r = await ingestDocument({ title: 't', content: '# A\n正文', docId: 'fixed' })
    expect(r.docId).toBe('fixed')
    // insertKbChunks 收到 kbId=docId
    const records = insertKbChunksMock.mock.calls[0][0] as Array<{ kbId: string; docId: string }>
    expect(records[0].kbId).toBe('fixed')
    expect(records[0].docId).toBe('fixed')
  })

  // P5：锁 heading 发射 → chunk meta.sectionTitle 收益。
  // extract.ts 给 PDF 发 `# Page N`、给 DOCX 经 htmlToMarkdown 发 `#`；
  // 这里验证该 heading 经 chunkDocument 进 KbChunkRecord.meta.sectionTitle，
  // 检索可按章节定位（不落 flat token-window）。
  it('P5 heading 发射 → chunk meta.sectionTitle 收 Page 标题', async () => {
    readyMock.mockResolvedValue(true)
    embedMock.mockResolvedValue([Float32Array.from([0.1, 0.2])])
    const r = await ingestDocument({
      title: 'pdf report',
      content: '# Page 1\nbody of page one',
    })
    expect(r.chunkCount).toBe(1)
    const records = insertKbChunksMock.mock.calls[0][0] as Array<{ meta: string }>
    const meta = JSON.parse(records[0].meta) as { sectionTitle: string | null }
    expect(meta.sectionTitle).toBe('Page 1')
  })
})
