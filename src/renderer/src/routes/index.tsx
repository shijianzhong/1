import { Route, Routes } from 'react-router-dom'
import { AppShell } from '@renderer/layouts/AppShell'
import { EditorPage } from '@renderer/pages/EditorPage'
import { CapabilitiesPage } from '@renderer/pages/CapabilitiesPage'
import { HomePage } from '@renderer/pages/HomePage'
import { ListPage } from '@renderer/pages/ListPage'
import { SettingsPage } from '@renderer/pages/SettingsPage'
import { TasksPage } from '@renderer/pages/TasksPage'

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomePage />} />
        {/* /editor = 能力列表入口；/editor/:capabilityId = 画布编辑器 */}
        <Route path="/editor" element={<CapabilitiesPage />} />
        <Route path="/editor/:capabilityId" element={<EditorPage />} />
        <Route
          path="/agents"
          element={<ListPage i18nKey="agents" />}
        />
        <Route
          path="/skills"
          element={<ListPage i18nKey="skills" />}
        />
        <Route
          path="/models"
          element={<ListPage i18nKey="models" />}
        />
        <Route
          path="/tasks"
          element={<TasksPage />}
        />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  )
}
