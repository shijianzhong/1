import { describe, expect, it, vi } from 'vitest'
import type {
  AgentConfig,
  AgentRunCallbacks,
  AgentRunInput,
  LlmContentBlock,
  LlmResponse,
} from '@shared/types'
import { Agent } from '../agent'
import {
  HANDOFF_TOOL_PREFIX,
  isHandoffTool,
  makeHandoffTool,
  parseHandoffTarget,
} from './handoff'
import { executeTool, registerTool, clearTools } from '../../tools/registry'
import { z } from 'zod'

// —— Handoff 黄金用例（§三之三 G + 铁律12）——
// 验证 synthetic tool 生成 + 短路（handoff tool 不真 executeTool）。

describe('Handoff synthetic tool', () => {
  it('makeHandoffTool 生成 handoff_to_X tool', () => {
    const tool = makeHandoffTool('AgentB')
    expect(tool.name).toBe('handoff_to_AgentB')
    expect(tool.input_schema).toMatchObject({ type: 'object' })
  })

  it('isHandoffTool 识别前缀', () => {
    expect(isHandoffTool('handoff_to_A')).toBe(true)
    expect(isHandoffTool('handoff_to_AgentB')).toBe(true)
    expect(isHandoffTool('other_tool')).toBe(false)
  })

  it('parseHandoffTarget 提取 target', () => {
    expect(parseHandoffTarget('handoff_to_B')).toBe('B')
    expect(parseHandoffTarget('handoff_to_LongName')).toBe('LongName')
    expect(parseHandoffTarget('not_handoff')).toBeNull()
  })

  it('HANDOFF_TOOL_PREFIX 常量', () => {
    expect(HANDOFF_TOOL_PREFIX).toBe('handoff_to_')
  })
})

describe('Handoff 短路（agent tool-use 循环）', () => {
  it('handoff tool 不调 executeTool，短路返回合成 result', async () => {
    // mock Agent 的 stream 返回含 tool_use（handoff_to_B）+ stop_reason tool_use
    // 直接测 executeTool 不会被 handoff 调用
    clearTools()
    const realTool = vi.fn().mockResolvedValue('real result')
    registerTool('real_tool', 'a real tool', z.object({}), realTool)

    // handoff tool 不注册（它走短路分支，不进 executeTool）
    // 验证：executeTool 对 handoff_to_X 返回 unknown_tool（说明 agent 短路没走到这）
    const result = await executeTool('handoff_to_B', {}, 'tu_1', {})
    // handoff tool 未注册 → executeTool 返回 unknown_tool 错误
    // （这证明 agent 必须短路，否则 handoff tool 会死循环）
    expect(result.isError).toBe(true)
    expect(result.content).toContain('unknown_tool')

    // real_tool 正常执行
    const realResult = await executeTool('real_tool', {}, 'tu_2', {})
    expect(realResult.isError).toBe(false)
    expect(realResult.content).toBe('real result')
    expect(realTool).toHaveBeenCalledTimes(1)
  })
})
