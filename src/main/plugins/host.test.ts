import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { pluginHost } from './host'
import { pluginEvents } from './events'
import {
  clearTools,
  executeTool,
  newToolUseId,
  type ToolContext,
} from '../tools/registry'

beforeEach(() => {
  clearTools()
  pluginEvents.clear()
})

describe('PluginHost.tools 代理', () => {
  it('register 包 registerTool，返回的 handle 可精确 unregister', () => {
    const handle = pluginHost.tools.register({
      name: 'test_echo',
      description: 'echo',
      params: z.object({ msg: z.string() }),
      handler: async (args) => ({ echoed: (args as { msg: string }).msg }),
    })
    expect(handle.name).toBe('test_echo')
    expect(pluginHost.tools.list().some((t) => t.name === 'test_echo')).toBe(true)

    handle.unregister()
    expect(pluginHost.tools.list().some((t) => t.name === 'test_echo')).toBe(false)
  })

  it('unregister(prefix) 按前缀注销并返回数量', () => {
    pluginHost.tools.register({ name: 'pf_a', description: 'a', params: z.object({}), handler: async () => null })
    pluginHost.tools.register({ name: 'pf_b', description: 'b', params: z.object({}), handler: async () => null })
    const n = pluginHost.tools.unregister('pf_')
    expect(n).toBe(2)
    expect(pluginHost.tools.list().every((t) => !t.name.startsWith('pf_'))).toBe(true)
  })

  it('list 返回 ToolDef[]（含 name/description/input_schema）', () => {
    pluginHost.tools.register({ name: 'pf_list', description: 'd', params: z.object({}), handler: async () => null })
    const def = pluginHost.tools.list().find((t) => t.name === 'pf_list')
    expect(def).toMatchObject({ name: 'pf_list', description: 'd' })
  })
})

describe('PluginHost.events + 运行事实投影', () => {
  it('订阅 tool.completed 在 executeTool 完成后收到带 toolName/runId 的载荷', async () => {
    pluginHost.tools.register({
      name: 'ev_tool',
      description: 'ev',
      params: z.object({ x: z.string() }),
      handler: async (args) => `ok:${(args as { x: string }).x}`,
    })
    const received: unknown[] = []
    const unsub = pluginHost.events.on('tool.completed', (p) => received.push(p))

    const ctx: ToolContext = { runId: 'run-1' }
    const res = await executeTool('ev_tool', { x: 'hi' }, newToolUseId(), ctx)

    expect(res.isError).toBe(false)
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ toolName: 'ev_tool', runId: 'run-1' })
    unsub()
  })

  it('on 返回的 unsubscribe 生效：取消后不再收到', async () => {
    pluginHost.tools.register({ name: 'ev_tool2', description: 'ev', params: z.object({}), handler: async () => 'ok' })
    let count = 0
    const unsub = pluginHost.events.on('tool.completed', () => {
      count++
    })
    await executeTool('ev_tool2', {}, newToolUseId(), { runId: 'r' })
    unsub()
    await executeTool('ev_tool2', {}, newToolUseId(), { runId: 'r' })
    expect(count).toBe(1)
  })

  it('某订阅者抛异常不影响事件源与其他订阅者', async () => {
    pluginHost.tools.register({ name: 'ev_tool3', description: 'ev', params: z.object({}), handler: async () => 'ok' })
    const good: unknown[] = []
    pluginHost.events.on('tool.completed', () => {
      throw new Error('boom')
    })
    pluginHost.events.on('tool.completed', (p) => good.push(p))
    await executeTool('ev_tool3', {}, newToolUseId(), { runId: 'r' })
    expect(good).toHaveLength(1)
  })
})
