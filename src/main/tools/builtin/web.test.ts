import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { clearTools, executeTool, listToolDefs } from '../registry'
import { registerWebTools } from './web'

// —— web_search / web_read 单测（stub 全局 fetch）——
// 重点覆盖：DDG 免 key 后端解析、JINA_API_KEY 切换 Jina 后端、4xx 不重试直接结构化错误。

const fetchMock = vi.fn()

// 按真实 Bing CN 响应结构构造（b_algo 块 / h2 锚点 / b_lineclamp2 摘要 / strong 高亮 / 相对日期前缀）
const BING_FIXTURE = `
<ol id="b_results">
<li class="b_algo" data-id iid=SERP.1><h2><a target="_blank" href="https://example.com/ai-news" h="ID=SERP,1.1"><strong>AI</strong> 编程最新动态 &amp; 趋势</a></h2><p class="b_lineclamp2">1 天前&ensp;&#0183;&ensp;这是第一条结果的<strong>摘要</strong>文本</p></li>
<li class="b_algo" data-id iid=SERP.2><h2><a target="_blank" href="https://direct.example.com/post" h="ID=SERP,2.1">第二条标题</a></h2><p class="b_lineclamp3">3 天前&ensp;&#0183;&ensp;第二条摘要</p></li>
</ol>
`

describe('tools/builtin/web', () => {
  beforeEach(() => {
    clearTools()
    registerWebTools()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    delete process.env.JINA_API_KEY
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.JINA_API_KEY
  })

  it('两个工具注册进清单（编排 agent 可见）', () => {
    const names = listToolDefs().map((t) => t.name)
    expect(names).toContain('web_search')
    expect(names).toContain('web_read')
  })

  it('web_read：走 Jina Reader 读全文并返回正文', async () => {
    fetchMock.mockResolvedValue(new Response('# 正文内容', { status: 200 }))
    const r = await executeTool('web_read', { url: 'https://example.com/a' }, 'tu_1', {})
    expect(r.isError).toBe(false)
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(true)
    expect(data.content).toContain('正文内容')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://r.jina.ai/https://example.com/a',
      expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': expect.any(String) }) }),
    )
  })

  it('web_read：非法 URL 直接拒绝，不发请求', async () => {
    const r = await executeTool('web_read', { url: 'not-a-url' }, 'tu_2', {})
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(false)
    expect(data.error).toBe('invalid_url')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('web_read：超长正文截断并标记 truncated', async () => {
    fetchMock.mockResolvedValue(new Response('x'.repeat(20_000), { status: 200 }))
    const r = await executeTool('web_read', { url: 'https://example.com/long' }, 'tu_3', {})
    const data = JSON.parse(r.content)
    expect(data.content.length).toBe(12_000)
    expect(data.truncated).toBe(true)
  })

  it('web_read：401 不重试，直接返回带 JINA_API_KEY 引导的错误 JSON', async () => {
    fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }))
    const r = await executeTool('web_read', { url: 'https://example.com/x' }, 'tu_4', {})
    expect(r.isError).toBe(false)
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(false)
    expect(data.error).toBe('http_401')
    expect(data.hint).toContain('JINA_API_KEY')
    expect(fetchMock).toHaveBeenCalledTimes(1) // 4xx 不进 registry 重试层
  })

  it('web_search 默认走 Bing CN：解析 b_algo 块/剥 strong/解码实体（含相对日期前缀）', async () => {
    fetchMock.mockResolvedValue(new Response(BING_FIXTURE, { status: 200 }))
    const r = await executeTool('web_search', { query: 'AI 编程' }, 'tu_5', {})
    expect(r.isError).toBe(false)
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(true)
    expect(data.backend).toBe('bing')
    expect(data.results).toHaveLength(2)
    expect(data.results[0]).toEqual({
      title: 'AI 编程最新动态 & 趋势',
      url: 'https://example.com/ai-news',
      snippet: '1 天前 · 这是第一条结果的摘要文本',
    })
    expect(data.results[1].url).toBe('https://direct.example.com/post')
    expect(data.results[1].snippet).toContain('3 天前')
    const calledUrl = fetchMock.mock.calls[0][0] as string
    expect(calledUrl).toBe(`https://cn.bing.com/search?q=${encodeURIComponent('AI 编程')}`)
  })

  it('web_search 带 JINA_API_KEY → 走 Jina Search 并带 Authorization', async () => {
    process.env.JINA_API_KEY = 'test-key'
    fetchMock.mockResolvedValue(new Response('jina 结果', { status: 200 }))
    const r = await executeTool('web_search', { query: 'LLM 框架' }, 'tu_6', {})
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(true)
    expect(data.backend).toBe('jina')
    expect(data.results).toContain('jina 结果')
    expect(fetchMock).toHaveBeenCalledWith(
      `https://s.jina.ai/?q=${encodeURIComponent('LLM 框架')}`,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-key' }) }),
    )
  })

  it('web_search：Bing 返回空页 → no_results 错误 JSON（不抛不重试）', async () => {
    fetchMock.mockResolvedValue(new Response('<html><body>no results</body></html>', { status: 200 }))
    const r = await executeTool('web_search', { query: 'xyz' }, 'tu_7', {})
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(false)
    expect(data.error).toBe('no_results')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('web_search：Bing 被拒（403）→ 结构化错误带后端切换引导', async () => {
    fetchMock.mockResolvedValue(new Response('challenge', { status: 403 }))
    const r = await executeTool('web_search', { query: 'xyz' }, 'tu_8', {})
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(false)
    expect(data.error).toBe('http_403')
    expect(data.hint).toContain('JINA_API_KEY')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
