import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
// 全部 locale 同步打进 bundle。
// 实证（startup.log 2026-08-05）：i18next-http-backend 在 Electron file:// + asar 下
// 每次拉 namespace 约卡 10.9s（重试超时），两次合计 ~22s。桌面应用无 CDN 需求，不走 HTTP。
import zhCnCommon from '../../public/locales/zh-CN/common.json'
import zhCnHome from '../../public/locales/zh-CN/home.json'
import zhCnEditor from '../../public/locales/zh-CN/editor.json'
import zhCnSettings from '../../public/locales/zh-CN/settings.json'
import zhCnRegistry from '../../public/locales/zh-CN/registry.json'
import zhCnErrors from '../../public/locales/zh-CN/errors.json'
import zhCnMcp from '../../public/locales/zh-CN/mcp.json'
import zhCnContent from '../../public/locales/zh-CN/content.json'
import zhCnKb from '../../public/locales/zh-CN/kb.json'
import enCommon from '../../public/locales/en/common.json'
import enHome from '../../public/locales/en/home.json'
import enEditor from '../../public/locales/en/editor.json'
import enSettings from '../../public/locales/en/settings.json'
import enRegistry from '../../public/locales/en/registry.json'
import enErrors from '../../public/locales/en/errors.json'
import enMcp from '../../public/locales/en/mcp.json'
import enContent from '../../public/locales/en/content.json'
import enKb from '../../public/locales/en/kb.json'
import { startupMark } from '@renderer/lib/startupMark'

const NAMESPACES = ['common', 'home', 'editor', 'settings', 'registry', 'errors', 'mcp', 'content', 'kb'] as const

// —— i18n（§十二）：默认 zh-CN；资源内联，禁止 HttpBackend ——
const isDev = !!import.meta.env.DEV
startupMark('renderer:i18n:init:begin')
void i18n
  .use(initReactI18next)
  .init({
    lng: 'zh-CN',
    fallbackLng: 'zh-CN',
    defaultNS: 'common',
    ns: [...NAMESPACES],
    resources: {
      'zh-CN': {
        common: zhCnCommon,
        home: zhCnHome,
        editor: zhCnEditor,
        settings: zhCnSettings,
        registry: zhCnRegistry,
        errors: zhCnErrors,
        mcp: zhCnMcp,
        content: zhCnContent,
        kb: zhCnKb,
      },
      en: {
        common: enCommon,
        home: enHome,
        editor: enEditor,
        settings: enSettings,
        registry: enRegistry,
        errors: enErrors,
        mcp: enMcp,
        content: enContent,
        kb: enKb,
      },
    },
    interpolation: {
      escapeValue: false,
    },
    // 关键：默认 true 会在 init 未完成时 suspend，且根上无 Suspense → 启动屏卡住
    react: {
      useSuspense: false,
    },
    saveMissing: isDev,
    missingKeyHandler: isDev
      ? (_lngs, ns, key) => {
          // eslint-disable-next-line no-console
          console.warn(`[i18n] missing key: ${ns}:${key}`)
        }
      : undefined,
  })
  .then(() => {
    startupMark('renderer:i18n:init:resolved', {
      isInitialized: i18n.isInitialized,
      backend: 'inline-resources',
    })
  })
  .catch((error: unknown) => {
    startupMark('renderer:i18n:init:rejected', {
      error: error instanceof Error ? error.message : String(error),
    })
  })

/** 兼容旧调用：资源已全部内联，无需懒加载 */
export function ensureNamespaces(_namespaces: string[]): void {
  // no-op
}

export default i18n
