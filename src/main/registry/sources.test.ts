import { describe, expect, it } from 'vitest'
import { buildSourceUrl, isValidSlug, shouldAttachToken } from './sources'

// —— 源 URL 拼装 / token 域名校验 / slug 校验（docs/REGISTRY_PLAN.md §4.1）——

describe('buildSourceUrl', () => {
  it('替换 {repo}/{ref}/{path} 占位', () => {
    expect(
      buildSourceUrl(
        { id: 'raw', urlTemplate: 'https://raw.githubusercontent.com/{repo}/{ref}/{path}' },
        'shijianzhong/one-registry',
        'main',
        'index.json',
      ),
    ).toBe('https://raw.githubusercontent.com/shijianzhong/one-registry/main/index.json')
  })

  it('jsdelivr 模板（{repo}@{ref}）', () => {
    expect(
      buildSourceUrl(
        { id: 'jsd', urlTemplate: 'https://cdn.jsdelivr.net/gh/{repo}@{ref}/{path}' },
        'o/r',
        'main',
        'skills/a/skill.zip',
      ),
    ).toBe('https://cdn.jsdelivr.net/gh/o/r@main/skills/a/skill.zip')
  })
})

describe('shouldAttachToken', () => {
  it('GitHub 系域名附带 token', () => {
    expect(shouldAttachToken('https://raw.githubusercontent.com/a/b/main/x')).toBe(true)
    expect(shouldAttachToken('https://api.github.com/repos/a/b')).toBe(true)
    expect(shouldAttachToken('https://github.com/a/b')).toBe(true)
  })

  it('镜像/自定义源不附带（防 token 泄漏）', () => {
    expect(shouldAttachToken('https://cdn.jsdelivr.net/gh/a/b/x')).toBe(false)
    expect(shouldAttachToken('https://ghproxy.com/https://raw.githubusercontent.com/a/b/x')).toBe(false)
    expect(shouldAttachToken('not a url')).toBe(false)
  })
})

describe('isValidSlug', () => {
  it('合法 slug', () => {
    expect(isValidSlug('code-reviewer')).toBe(true)
    expect(isValidSlug('web-research')).toBe(true)
    expect(isValidSlug('a')).toBe(true)
  })

  it('拒绝非法/穿越 slug', () => {
    expect(isValidSlug('../etc')).toBe(false)
    expect(isValidSlug('a/b')).toBe(false)
    expect(isValidSlug('A')).toBe(false)
    expect(isValidSlug('-lead')).toBe(false)
    expect(isValidSlug('')).toBe(false)
  })
})
