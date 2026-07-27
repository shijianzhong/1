import { defineConfig } from '@playwright/test'

// —— E2E（§10.4）：Playwright 驱动真实 Electron 窗口 ——
// 测试需先 npm run build 产物存在（out/）。
export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  expect: { timeout: 10000 },
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
