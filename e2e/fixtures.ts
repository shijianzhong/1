import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolve } from 'node:path'

// —— E2E 共享 fixture：启动 electron app + 独立 userData 隔离 ——
// 每个测试独立 SQLite + vault，互不污染；串行执行避免单例锁冲突。

export interface TestApp {
  app: ElectronApplication
  win: Page
  cleanup: () => Promise<void>
}

export async function launchApp(): Promise<TestApp> {
  const userData = mkdtempSync(join(tmpdir(), 'one-e2e-'))
  const app = await electron.launch({
    args: [resolve('out/main/index.js')],
    env: { ...process.env, NODE_ENV: 'test', ONE_USER_DATA: userData },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(
    () => document.getElementById('root')?.children.length,
    { timeout: 10000 },
  )
  return {
    app,
    win,
    cleanup: async () => {
      await app.close()
      rmSync(userData, { recursive: true, force: true })
    },
  }
}
