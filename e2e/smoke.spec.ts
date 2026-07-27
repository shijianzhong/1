import { expect, test } from '@playwright/test'
import { _electron as electron } from 'playwright'
import { resolve } from 'node:path'

// —— E2E smoke（§10.4）：启动真实 Electron 窗口，验证骨架可打开 + IPC 通路 ——
// 前置：npm run build 已产出 out/
// 不依赖 i18n 异步文案（flaky），改测结构性锚点 + IPC ping。
test('app launches, mounts root, and IPC ping responds', async () => {
  const app = await electron.launch({
    args: [resolve('out/main/index.js')],
    env: { ...process.env, NODE_ENV: 'test' },
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')

  // React 挂载 → #root 有子节点
  await window.waitForFunction(() => {
    const root = document.getElementById('root')
    return root !== null && root.children.length > 0
  }, { timeout: 10000 })

  // 窗口标题
  const title = await window.title()
  expect(title).toBe('One')

  // IPC 通路：preload 暴露的 window.one.system.ping 返回结构化 IpcResult
  const ping = await window.evaluate(() =>
    (window as unknown as { one: { system: { ping: () => Promise<unknown> } } })
      .one.system.ping(),
  )
  expect(ping).toMatchObject({ ok: true, data: { ok: true, appVersion: expect.any(String) } })

  await app.close()
})
