import i18n from 'i18next'
import HttpBackend from 'i18next-http-backend'
import { initReactI18next } from 'react-i18next'

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
