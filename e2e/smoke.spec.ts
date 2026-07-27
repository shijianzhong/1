import { expect, test } from '@playwright/test'
import { launchApp } from './fixtures'

// —— E2E smoke（§10.4）：启动真实 Electron 窗口，验证骨架可打开 + IPC 通路 ——
// 不依赖 i18n 异步文案（flaky），改测结构性锚点 + IPC ping。
test('app launches, mounts root, and IPC ping responds', async () => {
  const { win, cleanup } = await launchApp()

  const title = await win.title()
  expect(title).toBe('One')

  const ping = await win.evaluate(() =>
    (window as unknown as { one: { system: { ping: () => Promise<unknown> } } })
      .one.system.ping(),
  )
  expect(ping).toMatchObject({
    ok: true,
    data: { ok: true, appVersion: expect.any(String) },
  })

  await cleanup()
})
