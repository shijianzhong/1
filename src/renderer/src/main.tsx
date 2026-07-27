import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from '@renderer/App'
import '@renderer/i18n/index'
import '@renderer/styles/theme.css'
import '@renderer/styles/app.css'
import { bootstrapTheme } from '@renderer/bootstrap-theme'

// —— 防首屏闪白：React 挂载前同步应用上次缓存的明暗 + 点缀色 ——
bootstrapTheme()

// —— 渲染层全局错误兜底（§11.5）：不白屏 ——
window.addEventListener('error', (event) => {
  // eslint-disable-next-line no-console
  console.error('[renderer:error]', event.error ?? event.message)
})
window.addEventListener('unhandledrejection', (event) => {
  // eslint-disable-next-line no-console
  console.error('[renderer:unhandledrejection]', event.reason)
})

const queryClient = new QueryClient()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
)
