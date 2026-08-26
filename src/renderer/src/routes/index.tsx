import { lazy } from 'react'
import { Route, Routes } from 'react-router-dom'
import { AppShell } from '@renderer/layouts/AppShell'
// HomePage 是默认首屏，保持静态进首包；其余页面懒加载（AppShell 的 Suspense 边界兜底），
// 其中 EditorPage 带走 reactflow/d3 大图依赖，是冷启动首包减负的大头。
import { HomePage } from '@renderer/pages/HomePage'

const RunsPage = lazy(() =>
  import('@renderer/pages/RunsPage').then((m) => ({ default: m.RunsPage })),
)
const EditorPage = lazy(() =>
  import('@renderer/pages/EditorPage').then((m) => ({ default: m.EditorPage })),
)
const CapabilitiesPage = lazy(() =>
  import('@renderer/pages/CapabilitiesPage').then((m) => ({ default: m.CapabilitiesPage })),
)
const AgentsPage = lazy(() =>
  import('@renderer/pages/AgentsPage').then((m) => ({ default: m.AgentsPage })),
)
const SkillsPage = lazy(() =>
  import('@renderer/pages/SkillsPage').then((m) => ({ default: m.SkillsPage })),
)
const ListPage = lazy(() =>
  import('@renderer/pages/ListPage').then((m) => ({ default: m.ListPage })),
)
const RegistryPage = lazy(() =>
  import('@renderer/pages/RegistryPage').then((m) => ({ default: m.RegistryPage })),
)
const McpPage = lazy(() =>
  import('@renderer/pages/McpPage').then((m) => ({ default: m.McpPage })),
)
const PluginsPage = lazy(() =>
  import('@renderer/pages/PluginsPage').then((m) => ({ default: m.PluginsPage })),
)
const KbPage = lazy(() =>
  import('@renderer/pages/KbPage').then((m) => ({ default: m.KbPage })),
)
const MemoryPage = lazy(() =>
  import('@renderer/pages/MemoryPage').then((m) => ({ default: m.MemoryPage })),
)
const ComparePage = lazy(() =>
  import('@renderer/pages/ComparePage').then((m) => ({ default: m.ComparePage })),
)
const SettingsPage = lazy(() =>
  import('@renderer/pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
)
const TasksPage = lazy(() =>
  import('@renderer/pages/TasksPage').then((m) => ({ default: m.TasksPage })),
)
const SchedulesPage = lazy(() =>
  import('@renderer/pages/SchedulesPage').then((m) => ({ default: m.SchedulesPage })),
)

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomePage />} />
        {/* /capabilities = 能力列表入口；/capability/:id = 画布编排器 */}
        <Route path="/capabilities" element={<CapabilitiesPage />} />
        <Route path="/capability/:capabilityId" element={<EditorPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/skills" element={<SkillsPage />} />
        <Route path="/registry" element={<RegistryPage />} />
        <Route path="/models" element={<ListPage i18nKey="models" />} />
        <Route path="/mcp" element={<McpPage />} />
        <Route path="/plugins" element={<PluginsPage />} />
        <Route path="/kb" element={<KbPage />} />
        <Route path="/memory" element={<MemoryPage />} />
        <Route path="/compare" element={<ComparePage />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/runs" element={<RunsPage />} />
        <Route path="/schedules" element={<SchedulesPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  )
}
