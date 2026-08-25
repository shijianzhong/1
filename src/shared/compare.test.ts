import { describe, expect, it } from 'vitest'
import { deriveComparableModels } from './compare'
import type { Provider } from './types'

// Provider 字段较多，测试只需 models/name/id，强转即可
function fakeProvider(
  id: string,
  name: string,
  models: Partial<Record<'primary' | 'reasoning' | 'fast' | 'default', string>>,
): Provider {
  return { id, name, models } as unknown as Provider
}

describe('deriveComparableModels', () => {
  it('展开各 provider 的用途模型，过滤空值并生成复合 id', () => {
    const providers = [
      fakeProvider('p1', 'Anthropic', { primary: 'claude-a', reasoning: 'claude-b', fast: 'claude-c' }),
      fakeProvider('p2', 'OpenAI', { primary: 'gpt-4o' }),
    ]
    const got = deriveComparableModels(providers)
    expect(got).toHaveLength(4)
    expect(got.map((m) => m.id)).toEqual(['p1:primary', 'p1:reasoning', 'p1:fast', 'p2:primary'])
    expect(got[0]).toMatchObject({
      providerId: 'p1',
      usage: 'primary',
      modelId: 'claude-a',
      name: 'Anthropic · claude-a',
    })
  })

  it('跳过未填用途模型', () => {
    const providers = [fakeProvider('p1', 'Anthropic', { primary: 'claude-a' })]
    const got = deriveComparableModels(providers)
    expect(got).toHaveLength(1)
    expect(got[0].id).toBe('p1:primary')
  })

  it('空 providers 返回空数组', () => {
    expect(deriveComparableModels([])).toEqual([])
  })
})
