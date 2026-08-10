import { beforeEach, describe, expect, it } from 'vitest'
import { clearTools, executeTool } from '../registry'
import { clearPlans, getPlan, registerPlanTools } from './plan'

const ctx = { onApprove: async () => ({ approved: true }) }

beforeEach(() => {
  clearTools()
  clearPlans()
  registerPlanTools()
})

describe('update_plan', () => {
  it('注册并返回 plan', async () => {
    const r = await executeTool('update_plan', {
      plan: [
        { step: '读代码', status: 'completed' },
        { step: '改代码', status: 'in_progress' },
        { step: '测试', status: 'pending' },
      ],
    }, 'p1', ctx)
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(true)
    expect(data.plan).toHaveLength(3)
  })

  it('按 sessionId 隔离', async () => {
    await executeTool('update_plan', { plan: [{ step: 's1', status: 'pending' }] }, 'p2', { ...ctx, sessionId: 'sess-a' })
    await executeTool('update_plan', { plan: [{ step: 's2', status: 'completed' }] }, 'p3', { ...ctx, sessionId: 'sess-b' })
    expect(getPlan('sess-a')[0].step).toBe('s1')
    expect(getPlan('sess-b')[0].step).toBe('s2')
  })

  it('无 sessionId 用默认键', async () => {
    await executeTool('update_plan', { plan: [{ step: 'x', status: 'pending' }] }, 'p4', ctx)
    expect(getPlan()).toHaveLength(1)
  })

  it('explanation 透传', async () => {
    const r = await executeTool('update_plan', {
      plan: [{ step: 'a', status: 'completed' }],
      explanation: '第一步完成',
    }, 'p5', ctx)
    const data = JSON.parse(r.content)
    expect(data.explanation).toBe('第一步完成')
  })
})
