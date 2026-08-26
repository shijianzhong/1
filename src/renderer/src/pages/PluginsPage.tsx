import { useTranslation } from 'react-i18next'
import { PluginsSettings } from '@renderer/components/PluginsSettings'
import { PageToolbar } from '@renderer/components/ui/PageToolbar'

// —— 插件管理页（docs/PLUGIN_ARCHITECTURE.md §5 Stage 2）——
// 顶级导航：与 MCP 平行。展示 generated/A 声明式工具（用户在聊天里造的）+ skill 启停。
// 让"造完不是黑盒"——用户能核对自己造的工具到底声明了什么，可启停、可卸载。

export function PluginsPage() {
  const { t } = useTranslation(['plugins', 'common'])
  return (
    <div style={{ maxWidth: 720, margin: '0 auto', display: 'grid', gap: 16 }}>
      <PageToolbar title={t('plugins:title')} subtitle={t('plugins:subtitle')} />
      <PluginsSettings />
    </div>
  )
}
