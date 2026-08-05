import i18n from 'i18next'
import HttpBackend from 'i18next-http-backend'
import { initReactI18next } from 'react-i18next'
// 首屏 namespace 直接打进 bundle：打包版 file:// 下走 fetch 会串行排在 bundle 解析之后，
// 且 React 根无 Suspense 时整树等它 resolve（启动白屏的一段）。内联后 t() 立即可用。
// 单一事实源仍是 public/locales 下这份文件（构建期被 import 进 chunk，同时随 public 部署）。
import zhCnCommon from '../../public/locales/zh-CN/common.json'

// —— i18n（§十二）：默认 zh-CN，按 namespace 懒加载，文件在 public/locales/{lng}/{ns}.json ——
// file:// 下 loadPath 用相对路径，由 electron-vite 打包时随 public 资源一起部署。
const isDev = !!import.meta.env.DEV
void i18n
  .use(HttpBackend)
  .use(initReactI18next)
  .init({
    lng: 'zh-CN',
    fallbackLng: 'zh-CN',
    defaultNS: 'common',
    ns: ['common'], // 其它 namespace（home/editor/settings/errors）按需懒加载
    resources: {
      'zh-CN': { common: zhCnCommon },
    },
    // 已内联的只是部分资源：其余 namespace/语言仍走 backend 懒加载
    partialBundledLanguages: true,
    backend: {
      // dev: http://localhost:port/locales/...；prod: file://.../locales/...
      loadPath: './locales/{{lng}}/{{ns}}.json',
    },
    interpolation: {
      escapeValue: false,
    },
    // 开发期缺失 key 警告，生产静默回退
    saveMissing: isDev,
    missingKeyHandler: isDev
      ? (_lngs, ns, key) => {
          // eslint-disable-next-line no-console
          console.warn(`[i18n] missing key: ${ns}:${key}`)
        }
      : undefined,
  })

// 首屏之外按需加载的 namespace
export function ensureNamespaces(namespaces: string[]): void {
  for (const ns of namespaces) {
    if (!i18n.hasResourceBundle(i18n.language, ns)) {
      void i18n.loadNamespaces(ns)
    }
  }
}

export default i18n
