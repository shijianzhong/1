import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from '@renderer/App'
import '@renderer/i18n/index'
import '@renderer/styles/theme.css'
import '@renderer/styles/app.css'
import { bootstrapTheme } from '@renderer/bootstrap-theme'
import { flushBootMarks, startupMark } from '@renderer/lib/startupMark'

// —— 启动埋点：此处已在全部静态 import 求值之后（ESM hoist）。
//    html-boot-script → 本 mark 的间隔 = vendor/ui/index 加载+求值耗时。
//    HTML 阶段见 public/boot-mark.js ——
startupMark('renderer:main-tsx:after-imports')
flushBootMarks()

// —— 防首屏闪白：React 挂载前同步应用上次缓存的明暗 + 点缀色 ——
bootstrapTheme()
startupMark('renderer:bootstrap-theme-done')

// —— 渲染层全局错误兜底（§11.5）：不白屏 ——
window.addEventListener('error', (event) => {
  // eslint-disable-next-line no-console
  console.error('[renderer:error]', event.error ?? event.message)
  startupMark('renderer:window-error', {
    message: String(event.message ?? event.error ?? ''),
  })
})
window.addEventListener('unhandledrejection', (event) => {
  // eslint-disable-next-line no-console
  console.error('[renderer:unhandledrejection]', event.reason)
  startupMark('renderer:unhandledrejection', {
    reason: String(event.reason ?? ''),
  })
})

const queryClient = new QueryClient()

startupMark('renderer:createRoot:before')
ReactDOM.createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
)
startupMark('renderer:createRoot:after-render-call')
