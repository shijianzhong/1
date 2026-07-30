import { Route, Routes } from 'react-router-dom'
import { AppShell } from '@renderer/layouts/AppShell'
import { EditorPage } from '@renderer/pages/EditorPage'
import { CapabilitiesPage } from '@renderer/pages/CapabilitiesPage'
import { HomePage } from '@renderer/pages/HomePage'
import { AgentsPage } from '@renderer/pages/AgentsPage'
import { SkillsPage } from '@renderer/pages/SkillsPage'
import { ListPage } from '@renderer/pages/ListPage'
import { SettingsPage } from '@renderer/pages/SettingsPage'
import { TasksPage } from '@renderer/pages/TasksPage'

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
        <Route path="/models" element={<ListPage i18nKey="models" />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  )
}
