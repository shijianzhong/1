import { describe, expect, it } from 'vitest'
import { buildSystemPrefix } from './system-prefix'

describe('system-prefix', () => {
  it('返回非空字符串', () => {
    expect(buildSystemPrefix().length).toBeGreaterThan(300)
  })
  it('含 autonomy 纪律', () => {
    expect(buildSystemPrefix()).toContain('坚持到任务完全解决')
  })
  it('含工具并发指引', () => {
    expect(buildSystemPrefix()).toContain('并行')
  })
  it('含先搜索再动手', () => {
    expect(buildSystemPrefix()).toContain('grep')
  })
  it('含 output style 分档', () => {
    expect(buildSystemPrefix()).toContain('小改动')
  })
  it('含 planning 引导', () => {
    expect(buildSystemPrefix()).toContain('update_plan')
  })
})
