import { useTranslation } from 'react-i18next'
import { McpSettings } from '@renderer/components/McpSettings'
import { PageToolbar } from '@renderer/components/ui/PageToolbar'

// —— MCP 服务器管理页（§7.2）——
// 顶级导航：与 Models 平行，均为「给 Agent 接外部服务」的连接配置。
// Settings 只保留静态偏好（外观/档案/关于）；运行时连接管理独立成页，
// 让连接状态、测试连接、审批模式等「活的」反馈不被埋没在设置子区。
// 配置持久化在 config/mcp-servers.json，连接状态运行时维护。

export function McpPage() {
  const { t } = useTranslation(['mcp', 'common'])
  return (
    <div style={{ maxWidth: 720, margin: '0 auto', display: 'grid', gap: 16 }}>
      <PageToolbar title={t('mcp:title')} subtitle={t('mcp:subtitle')} />
      <McpSettings />
    </div>
  )
}
