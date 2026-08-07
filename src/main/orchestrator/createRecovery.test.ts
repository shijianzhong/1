import { describe, expect, it } from 'vitest'
import {
  inferCreateKind,
  inferCreateKindFromText,
  needsCreateRecovery,
  proposeToolNameForKind,
} from './createRecovery'

describe('needsCreateRecovery', () => {
  it('成功幻觉：技能已添加 / 能力已配好 / 已就绪 → true', () => {
    expect(needsCreateRecovery('品牌文案规范技能已添加')).toBe(true)
    expect(needsCreateRecovery('写作工作流能力已配好')).toBe(true)
    expect(needsCreateRecovery('角色已就绪，可以直接用')).toBe(true)
  })

  it('否认持久化 → true', () => {
    expect(needsCreateRecovery('刚才只是模拟，对话环境中没有存储')).toBe(true)
  })

  it('正当引导「确认入库」→ false', () => {
    expect(needsCreateRecovery('已生成预览，请在下方卡片中确认入库')).toBe(false)
    expect(needsCreateRecovery('请在下方确认')).toBe(false)
  })
})

describe('inferCreateKind（R1 关键词表）', () => {
  it('用户说工作流 → capability，不误判 agent', () => {
    expect(inferCreateKind('帮我建一个写作工作流', '好的')).toBe('capability')
    expect(inferCreateKindFromText('帮我建一个写作工作流')).toBe('capability')
  })

  it('用户说技能 → skill', () => {
    expect(inferCreateKind('做一个品牌文案规范技能', '')).toBe('skill')
  })

  it('用户说角色 → agent', () => {
    expect(inferCreateKind('创建一个热评刺客角色', '')).toBe('agent')
  })

  it('用户说人设 / 叫我 → persona', () => {
    expect(inferCreateKind('以后叫我老板，改一下人设', '')).toBe('persona')
  })

  it('用户无命中时扫助手正文', () => {
    expect(inferCreateKind('好的', '技能已添加，可以用了')).toBe('skill')
  })

  it('都无命中 → null', () => {
    expect(inferCreateKind('今天天气怎么样', '晴天')).toBeNull()
  })

  it('proposeToolNameForKind 映射', () => {
    expect(proposeToolNameForKind('skill')).toBe('propose_skill')
    expect(proposeToolNameForKind('capability')).toBe('propose_capability')
  })
})
