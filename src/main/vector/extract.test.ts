import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcErrorThrow } from '@shared/types'

// —— extract.ts 单测（docs/VECTOR_KB_PLAN.md §八 P5）——
// mock unpdf/mammoth（懒 await import() → vi.mock 仍生效）+ fs + global fetch。
// 关键覆盖：
//  (a) PDF 每页插 `# Page N` 标题 → chunkDocument 产 per-page sectionTitle
//  (b) DOCX → mammoth.convertToHtml → htmlToMarkdown（`<h1>`→`# `）
//  (c) txt/md 直读原文
//  (d) 不支持扩展名 → IpcErrorThrow('errors:kb.unsupported_file_type')
//  (e) 空抽取 → IpcErrorThrow('errors:kb.empty_extraction')
//  (f) 文件过大 → IpcErrorThrow('errors:kb.file_too_large')
//  (g) extractFromUrl → Jina markdown，title 取首行 `#`
//  (h) htmlToMarkdown 各标签映射

// —— unpdf mock ——
const extractTextMock = vi.fn()
vi.mock('unpdf', () => ({
  extractText: extractTextMock,
}))

// —— mammoth mock ——
const convertToHtmlMock = vi.fn()
vi.mock('mammoth', () => ({
  convertToHtml: convertToHtmlMock,
}))

// —— fs mock：readFileSync + statSync ——
const readMock = vi.fn()
const statMock = vi.fn()
vi.mock('node:fs', () => ({
  readFileSync: readMock,
  statSync: statMock,
}))

// fetch mock（extractFromUrl）
const fetchMock = vi.fn()
const originalFetch = globalThis.fetch

beforeEach(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

beforeEach(() => {
  extractTextMock.mockReset()
  convertToHtmlMock.mockReset()
  readMock.mockReset()
  statMock.mockReset()
  fetchMock.mockReset()
})

const { extractFromFile, extractFromUrl, htmlToMarkdown } = await import('./extract')

// 默认 stat 成功 + 小文件
function setStatSize(bytes: number): void {
  statMock.mockReturnValue({ size: bytes })
}

describe('extractFromFile — PDF', () => {
  it('每页文本间插 `# Page N`，title=basename，sourceKind=pdf', async () => {
    setStatSize(100)
    readMock.mockReturnValue(Buffer.from('fake pdf'))
    extractTextMock.mockResolvedValue({ totalPages: 2, text: ['Page one text', 'Page two text'] })
    const doc = await extractFromFile('/tmp/report.pdf')
    expect(doc.sourceKind).toBe('pdf')
    expect(doc.title).toBe('report.pdf')
    expect(doc.content).toContain('# Page 1')
    expect(doc.content).toContain('Page one text')
    expect(doc.content).toContain('# Page 2')
    expect(doc.content).toContain('Page two text')
  })

  it('空页过滤后全空 → empty_extraction', async () => {
    setStatSize(10)
    readMock.mockReturnValue(Buffer.from('x'))
    extractTextMock.mockResolvedValue({ totalPages: 2, text: ['   ', ''] })
    await expect(extractFromFile('/tmp/x.pdf')).rejects.toThrow(IpcErrorThrow)
    await expect(extractFromFile('/tmp/x.pdf')).rejects.toMatchObject({
      messageKey: 'errors:kb.empty_extraction',
    })
  })

  it('unpdf 抛错 → extract_failed', async () => {
    setStatSize(10)
    readMock.mockReturnValue(Buffer.from('x'))
    extractTextMock.mockRejectedValue(new Error('pdf parse boom'))
    await expect(extractFromFile('/tmp/x.pdf')).rejects.toMatchObject({
      messageKey: 'errors:kb.extract_failed',
    })
  })
})

describe('extractFromFile — DOCX', () => {
  it('convertToHtml → htmlToMarkdown，`<h1>`→`# `，title 取首标题', async () => {
    setStatSize(100)
    readMock.mockReturnValue(Buffer.from('fake docx'))
    convertToHtmlMock.mockResolvedValue({ value: '<h1>Report Title</h1><p>Body text</p>' })
    const doc = await extractFromFile('/tmp/doc.docx')
    expect(doc.sourceKind).toBe('docx')
    expect(doc.title).toBe('Report Title') // 首个 `#` 标题
    expect(doc.content).toContain('# Report Title')
    expect(doc.content).toContain('Body text')
  })

  it('抽取后内容空 → empty_extraction', async () => {
    setStatSize(100)
    readMock.mockReturnValue(Buffer.from('x'))
    convertToHtmlMock.mockResolvedValue({ value: '   ' })
    await expect(extractFromFile('/tmp/doc.docx')).rejects.toMatchObject({
      messageKey: 'errors:kb.empty_extraction',
    })
  })
})

describe('extractFromFile — txt/md', () => {
  it('txt 直读原文，sourceKind=txt', async () => {
    setStatSize(20)
    readMock.mockReturnValue('plain text content')
    const doc = await extractFromFile('/tmp/notes.txt')
    expect(doc.sourceKind).toBe('txt')
    expect(doc.title).toBe('notes.txt')
    expect(doc.content).toBe('plain text content')
  })

  it('md 直读原文，sourceKind=md', async () => {
    setStatSize(20)
    readMock.mockReturnValue('# Heading\nbody')
    const doc = await extractFromFile('/tmp/notes.md')
    expect(doc.sourceKind).toBe('md')
    expect(doc.content).toBe('# Heading\nbody')
  })

  it('空文件 → empty_extraction', async () => {
    setStatSize(0)
    readMock.mockReturnValue('   ')
    await expect(extractFromFile('/tmp/empty.txt')).rejects.toMatchObject({
      messageKey: 'errors:kb.empty_extraction',
    })
  })
})

describe('extractFromFile — 不支持类型 / size guard', () => {
  it('未知扩展名 → unsupported_file_type', async () => {
    setStatSize(10)
    await expect(extractFromFile('/tmp/x.unknown')).rejects.toMatchObject({
      messageKey: 'errors:kb.unsupported_file_type',
    })
  })

  it('文件 > 20MB → file_too_large（不读文件）', async () => {
    statMock.mockReturnValue({ size: 21 * 1024 * 1024 })
    const doc = extractFromFile('/tmp/huge.pdf')
    await expect(doc).rejects.toMatchObject({ messageKey: 'errors:kb.file_too_large' })
    expect(readMock).not.toHaveBeenCalled()
  })

  it('stat 失败 → extract_failed', async () => {
    statMock.mockImplementation(() => {
      throw new Error('enoent')
    })
    await expect(extractFromFile('/tmp/missing.pdf')).rejects.toMatchObject({
      messageKey: 'errors:kb.extract_failed',
    })
  })
})

describe('extractFromUrl', () => {
  it('Jina markdown → content，title 取首行 `#`，sourceKind=url', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => '# Article Title\n\nFirst paragraph.\n\nSecond.',
    })
    const doc = await extractFromUrl('https://example.com/post/123')
    expect(doc.sourceKind).toBe('url')
    expect(doc.title).toBe('Article Title')
    expect(doc.content).toContain('First paragraph.')
  })

  it('无 `#` 首行 → title=hostname', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => 'just plain text no heading' })
    const doc = await extractFromUrl('https://example.com/x')
    expect(doc.title).toBe('example.com')
  })

  it('HTTP 非 2xx → url_fetch_failed', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 })
    await expect(extractFromUrl('https://example.com/x')).rejects.toMatchObject({
      messageKey: 'errors:kb.url_fetch_failed',
    })
  })

  it('网络异常 → url_fetch_failed', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    await expect(extractFromUrl('https://example.com/x')).rejects.toMatchObject({
      messageKey: 'errors:kb.url_fetch_failed',
    })
  })

  it('非 http(s) url → url_fetch_failed', async () => {
    await expect(extractFromUrl('ftp://x.com/file')).rejects.toMatchObject({
      messageKey: 'errors:kb.url_fetch_failed',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('空响应 → empty_extraction', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => '   ' })
    await expect(extractFromUrl('https://example.com/x')).rejects.toMatchObject({
      messageKey: 'errors:kb.empty_extraction',
    })
  })

  it('JINA_API_KEY 在 Authorization 头（主进程 env，不入渲染层）', async () => {
    process.env.JINA_API_KEY = 'test-key'
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => '# T\nbody' })
    await extractFromUrl('https://example.com/x')
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers.Authorization).toBe('Bearer test-key')
    delete process.env.JINA_API_KEY
  })
})

describe('htmlToMarkdown — 标签映射', () => {
  it('h1-h6 → #-######', () => {
    expect(htmlToMarkdown('<h1>A</h1><h2>B</h2><h3>C</h3>')).toBe('# A\n\n## B\n\n### C')
  })

  it('ul/ol 列表', () => {
    const md = htmlToMarkdown('<ul><li>one</li><li>two</li></ul>')
    expect(md).toContain('- one')
    expect(md).toContain('- two')
    const md2 = htmlToMarkdown('<ol><li>a</li><li>b</li></ol>')
    expect(md2).toContain('1. a')
    expect(md2).toContain('2. b')
  })

  it('嵌套列表不错位：内层条目独立成行、外层条目不粘连（review #7）', () => {
    // docx 多级列表经 mammoth 产出真正的嵌套 <ul>
    const md = htmlToMarkdown(
      '<ul><li>顶层A<ul><li>子B</li><li>子C</li></ul></li><li>顶层D</li></ul>',
    )
    expect(md).toContain('- 顶层A')
    expect(md).toContain('- 子B')
    expect(md).toContain('- 子C')
    expect(md).toContain('- 顶层D')
    // 修复前：顶层A 与子B 粘连成「- 顶层A子B」、顶层D 丢前缀
    expect(md).not.toContain('顶层A子B')
  })

  it('ul 内嵌 ol 交叉嵌套也能收敛', () => {
    const md = htmlToMarkdown('<ul><li>A<ol><li>x</li><li>y</li></ol></li></ul>')
    expect(md).toContain('- A')
    expect(md).toContain('1. x')
    expect(md).toContain('2. y')
  })

  it('a 链接 → [text](href)', () => {
    expect(htmlToMarkdown('<a href="https://x.com">link</a>')).toBe('[link](https://x.com)')
  })

  it('strong/em/code 行内', () => {
    expect(htmlToMarkdown('<strong>bold</strong>')).toBe('**bold**')
    expect(htmlToMarkdown('<em>ital</em>')).toBe('*ital*')
    expect(htmlToMarkdown('<code>x</code>')).toBe('`x`')
  })

  it('pre 代码块', () => {
    const md = htmlToMarkdown('<pre>line1\nline2</pre>')
    expect(md).toContain('```')
    expect(md).toContain('line1')
    expect(md).toContain('line2')
  })

  it('嵌套 + 剥余标签 + 实体解码', () => {
    const md = htmlToMarkdown('<p>foo &amp; bar</p><p>baz</p>')
    expect(md).toContain('foo & bar')
    expect(md).toContain('baz')
  })

  it('空输入 → 空串', () => {
    expect(htmlToMarkdown('')).toBe('')
  })
})
