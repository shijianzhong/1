import { Route, Routes } from 'react-router-dom'
import { AppShell } from '@renderer/layouts/AppShell'
import { EditorPage } from '@renderer/pages/EditorPage'
import { HomePage } from '@renderer/pages/HomePage'
import { ListPage } from '@renderer/pages/ListPage'
import { SettingsPage } from '@renderer/pages/SettingsPage'
import { TasksPage } from '@renderer/pages/TasksPage'

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomePage />} />
        {/* §八之二 A：capabilityId 为空时新建，非空时加载已有能力 */}
        <Route path="/editor" element={<EditorPage />} />
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
