import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// —— 测试脚手架（§十）——
// 单元测试 vitest；E2E 用 @playwright/test（见 playwright.config.ts）。
// 编排引擎/记忆/重试/主题派生 单测在此跑；LLM 调用一律 mock（§10.5）。
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main'),
      '@renderer': resolve('src/renderer/src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
})
