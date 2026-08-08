import { describe, expect, it } from 'vitest'
import { filterToolsByAllowlist } from './allowlist'
import type { LlmToolDef } from '@shared/types'

const tools: LlmToolDef[] = [
  { name: 'memory_recall', description: 'r', input_schema: { type: 'object', properties: {} } },
  { name: 'shell_run', description: 's', input_schema: { type: 'object', properties: {} } },
  { name: 'web_search', description: 'w', input_schema: { type: 'object', properties: {} } },
]

describe('filterToolsByAllowlist', () => {
  it('undefined / 空 = 不限制', () => {
    expect(filterToolsByAllowlist(tools, undefined)).toEqual(tools)
    expect(filterToolsByAllowlist(tools, [])).toEqual(tools)
  })

  it('非空白名单只保留列出的工具', () => {
    expect(filterToolsByAllowlist(tools, ['shell_run', 'web_search']).map((t) => t.name)).toEqual([
      'shell_run',
      'web_search',
    ])
  })
})
