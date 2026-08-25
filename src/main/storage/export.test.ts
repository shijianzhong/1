import { beforeEach, describe, expect, it, vi } from 'vitest'

// 导出模块依赖 ./sessions 的 DB 读取；纯函数 messagesToMarkdown 不触发，但
// sessionToMarkdown 需要，故整体 mock ./sessions 以注入受控数据（不碰真实库）。
vi.mock('./sessions', () => ({
  getSession: vi.fn(),
  listMessages: vi.fn(),
}))

import { getSession, listMessages } from './sessions'
import { messagesToMarkdown, sessionToMarkdown } from './export'
import type { SessionMessage } from '@shared/types'

function msg(partial: Partial<SessionMessage>): SessionMessage {
  return {
    id: 'm',
    sessionId: 's',
    role: 'user',
    content: '',
    createdAt: 1,
    ...partial,
  }
}

describe('messagesToMarkdown', () => {
  it('普通用户文本按角色标题渲染', () => {
    expect(messagesToMarkdown([msg({ role: 'user', content: '你好' })])).toBe(
      '### 👤 用户\n\n你好\n',
    )
  })

  it('assistant 结构化消息还原 text + tool_use 块', () => {
    const content = JSON.stringify([
      { type: 'text', text: '让我查一下' },
      { type: 'tool_use', id: 't1', name: 'shell', input: { cmd: 'ls' } },
    ])
    expect(messagesToMarkdown([msg({ role: 'assistant', content, meta: { structured: true } })])).toBe(
      '### 🤖 助手\n\n让我查一下\n\n> **🔧 调用工具 `shell`**\n\n```json\n{\n  "cmd": "ls"\n}\n```\n',
    )
  })

  it('tool 结构化消息还原 tool_result 块', () => {
    const content = JSON.stringify([
      { type: 'tool_result', tool_use_id: 't1', content: 'file.txt' },
    ])
    expect(messagesToMarkdown([msg({ role: 'tool', content, meta: { structured: true } })])).toBe(
      '### 🔧 工具\n\n> **📦 工具结果**\n\n```\nfile.txt\n```\n',
    )
  })

  it('空消息返回空串', () => {
    expect(messagesToMarkdown([])).toBe('')
  })

  it('structured 标记但 content 非合法 JSON 时降级为空体、不抛', () => {
    expect(
      messagesToMarkdown([msg({ role: 'assistant', content: 'not json', meta: { structured: true } })]),
    ).toBe('### 🤖 助手\n')
  })

  it('带 title/createdAt 时输出一级标题与导出元信息', () => {
    const out = messagesToMarkdown([msg({ role: 'user', content: 'hi' })], {
      title: '会话A',
      createdAt: 0,
    })
    expect(out.startsWith('# 会话A\n')).toBe(true)
    expect(out).toContain('> 导出时间：')
    expect(out).toContain('### 👤 用户\n\nhi')
  })
})

describe('sessionToMarkdown', () => {
  beforeEach(() => {
    vi.mocked(getSession).mockReset()
    vi.mocked(listMessages).mockReset()
  })

  it('会话不存在返回空串', () => {
    vi.mocked(getSession).mockReturnValue(null)
    expect(sessionToMarkdown('missing')).toBe('')
  })

  it('读取会话标题与消息并渲染', () => {
    vi.mocked(getSession).mockReturnValue({
      id: 's',
      userId: 'local',
      title: '会话A',
      createdAt: 123,
      updatedAt: 123,
    })
    vi.mocked(listMessages).mockReturnValue([msg({ role: 'user', content: '第一条' })])
    const out = sessionToMarkdown('s')
    expect(out.startsWith('# 会话A\n')).toBe(true)
    expect(out).toContain('### 👤 用户\n\n第一条')
  })
})
