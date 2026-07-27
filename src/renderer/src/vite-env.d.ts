/// <reference types="vite/client" />

// window.one.* 类型从 preload 派生（单一契约源，§5.1.3 注）
// preload 与渲染层共享 @shared/types，避免双处声明漂移
import type { OneApi } from '@preload/index'

declare global {
  interface Window {
    one: OneApi
  }
}

export {}
