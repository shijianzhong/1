import { defineConfig } from '@playwright/test'

// —— E2E（§10.4）：Playwright 驱动真实 Electron 窗口 ——
// 串行执行（workers:1）：单例锁按 app name 区分，并行多实例会互斥退出。
// 每个测试用 ONE_USER_DATA env 隔离 userData（独立 SQLite + vault）。
export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'electron',
      use: {},
    },
  ],
})
