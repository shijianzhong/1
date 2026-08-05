import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@main': resolve('src/main'),
        '@shared': resolve('src/shared'),
      },
    },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: resolve('src/main/index.ts'),
        output: {
          // electron 37 实测 ESM named export 不可用（仅 default export）→ 主进程用 CJS 保住 named import
          format: 'cjs',
          entryFileNames: 'index.cjs',
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@preload': resolve('src/preload'),
        '@shared': resolve('src/shared'),
      },
    },
    build: {
      outDir: 'out/preload',
      // sandbox:true 下 preload 必须是 CJS（Electron sandbox 无 ESM loader）
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    publicDir: resolve('src/renderer/public'),
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
      },
    },
    plugins: [react(), tailwindcss()],
    build: {
      outDir: resolve('out/renderer'),
      rollupOptions: {
        input: resolve('src/renderer/index.html'),
        output: {
          // 手动分包（冷启动减负）：大依赖拆出首包，配合路由懒加载按需拉取。
          // 顺序敏感：katex 须在 markdown 链之前判断（rehype-katex 含 'rehype'）。
          manualChunks(id: string): string | undefined {
            if (!id.includes('node_modules')) return undefined
            if (/[\\/]node_modules[\\/](@xyflow|d3-)/.test(id)) return 'reactflow'
            if (/[\\/]node_modules[\\/]katex[\\/]/.test(id)) return 'katex'
            if (
              /[\\/]node_modules[\\/](react-markdown|remark-|rehype-|micromark|mdast-|hast-|unist-|unified|vfile|highlight\.js|lowlight|property-information|space-separated-tokens|comma-separated-tokens|decode-named-character-reference|character-entities|trim-lines|bail|trough|devlop|estree-util|mdurl|html-url-attributes)/.test(
                id,
              )
            ) {
              return 'markdown'
            }
            if (/[\\/]node_modules[\\/](framer-motion|motion-dom|motion-utils|tslib)/.test(id)) {
              return 'motion'
            }
            if (
              /[\\/]node_modules[\\/](@radix-ui|lucide-react|aria-hidden|react-remove-scroll|detect-node-es|get-nonce)/.test(
                id,
              )
            ) {
              return 'ui'
            }
            if (
              /[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|@tanstack|zustand|i18next|clsx|tailwind-merge|class-variance-authority|zod)[\\/]/.test(
                id,
              )
            ) {
              return 'vendor'
            }
            return undefined
          },
        },
      },
    },
  },
})
