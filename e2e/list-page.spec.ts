import { expect, test } from '@playwright/test'
import { launchApp } from './fixtures'

// —— 列表页集成测试（§10.3）：IPC + 真实 SQLite + CRUD 通路 ——
// 验证 agents 列表加载、新建落盘、删除。阶段1 M1 验收核心。
test('agents list: create via IPC, persists, then delete', async () => {
  const { win, cleanup } = await launchApp()

  // create
  const created = await win.evaluate(async () => {
    return (await (window as unknown as {
      one: { agents: { save: (i: { name: string; instructions: string; source: 'custom' }) => Promise<{ ok: boolean; data?: { id: string } }> } }
    }).one.agents.save({ name: 'E2E 测试角色', instructions: 'i18n', source: 'custom' }))
  })
  expect(created.ok).toBe(true)
  const agentId = created.data?.id
  expect(agentId).toBeTruthy()

  // list 含新建项
  const list = await win.evaluate(async () => {
    return (await (window as unknown as {
      one: { agents: { list: () => Promise<{ ok: boolean; data?: { name: string }[] }> } }
    }).one.agents.list())
  })
  expect(list.ok).toBe(true)
  expect(list.data?.some((a) => a.name === 'E2E 测试角色')).toBe(true)

  // remove
  const removed = await win.evaluate(async (id) => {
    return (await (window as unknown as {
      one: { agents: { remove: (id: string) => Promise<{ ok: boolean }> } }
    }).one.agents.remove(id))
  }, agentId as string)
  expect(removed.ok).toBe(true)

  await cleanup()
})
