import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  Bot,
  BookOpen,
  Boxes,
  Brain,
  Cable,
  Columns2,
  Command,
  Download,
  Plug,
  Plus,
  Settings,
  Sparkles,
  Store,
  Trash2,
  Wrench,
} from 'lucide-react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import type { Session } from '@shared/types'
import { useSessions } from '@renderer/api/hooks'
import { useChatStore } from '@renderer/store/chat'
import { confirmDialog } from '@renderer/components/ui/ConfirmDialog'
import { SessionExportDrawer } from '@renderer/components/SessionExportDrawer'
import { CommandPalette } from '@renderer/components/CommandPalette'
import { startupMark } from '@renderer/lib/startupMark'

const navItems = [
  { to: '/', key: 'home', icon: Sparkles },
  { to: '/capabilities', key: 'capabilities', icon: Boxes },
  { to: '/agents', key: 'agents', icon: Bot },
  { to: '/skills', key: 'skills', icon: Wrench },
  { to: '/registry', key: 'registry', icon: Store },
  { to: '/models', key: 'models', icon: Cable },
  { to: '/mcp', key: 'mcp', icon: Plug },
  { to: '/kb', key: 'kb', icon: BookOpen },
  { to: '/memory', key: 'memory', icon: Brain },
  { to: '/compare', key: 'compare', icon: Columns2 },
  { to: '/tasks', key: 'tasks', icon: Command },
  { to: '/runs', key: 'runs', icon: Activity },
  { to: '/settings', key: 'settings', icon: Settings },
] as const

/** 路由懒加载 fallback：纯视觉三点，无文案（i18n 与品牌色变量均已就绪） */
function PageLoading() {
  const { t } = useTranslation(['common'])
  return (
    <div
      className="grid h-full min-h-[240px] place-items-center"
      role="status"
      aria-label={t('common:status.connecting')}
    >
      <div className="flex gap-1.5" aria-hidden="true">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--color-brand-400,#4ECDC4)] [animation-delay:-0.32s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--color-brand-400,#4ECDC4)] [animation-delay:-0.16s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--color-brand-400,#4ECDC4)]" />
      </div>
    </div>
  )
}

let appShellFirstRenderLogged = false

export function AppShell() {
  if (!appShellFirstRenderLogged) {
    appShellFirstRenderLogged = true
    // 若此处距 enter-routes 很久：多半卡在 useTranslation(editor/home) Suspense
    startupMark('renderer:AppShell:first-render-begin')
  }
  const { t, ready } = useTranslation(['common', 'editor', 'home'])
  const nsReadyLogged = useRef(false)
  useEffect(() => {
    if (ready && !nsReadyLogged.current) {
      nsReadyLogged.current = true
      startupMark('renderer:AppShell:i18n-ready', {
        ns: 'common,editor,home',
      })
    }
  }, [ready])
  useEffect(() => {
    startupMark('renderer:AppShell:mounted')
  }, [])
  const location = useLocation()

  const showSideList = location.pathname === '/'
  const isEditor = location.pathname.startsWith('/capability/')
  // EditorPage 自带 Inspector + NodePalette，AppShell 不再显示
  const showInspector = false
  const currentPage = navItems.find((item) => item.to === location.pathname) ?? navItems[0]
  const qc = useQueryClient()
  const sessionsQ = useSessions()
  const chatSessions = useChatStore((s) => s.sessions)
  const currentSessionId = useChatStore((s) => s.sessionId)
  const selectSession = useChatStore((s) => s.selectSession)
  const newSession = useChatStore((s) => s.newSession)
  const removeSession = useChatStore((s) => s.removeSession)
  const loadSessions = useChatStore((s) => s.loadSessions)
  // 首页加载会话列表
  useEffect(() => {
    if (showSideList) void loadSessions()
  }, [showSideList, loadSessions])
  // 侧栏只列主 Agent 会话：编辑器试跑记录（capabilityId 非空）是能力调试产物，
  // 不进主对话历史（在编辑器「运行对话」tab 的历史下拉里回看）
  const recentItems = useMemo(
    () =>
      (chatSessions.length ? chatSessions : sessionsQ.data ?? [])
        .filter((s) => !s.capabilityId)
        .slice(0, 20),
    [chatSessions, sessionsQ.data],
  )

  // 会话导出抽屉（§亮点②）
  const [exportSession, setExportSession] = useState<Session | null>(null)

  // Cmd+K / Ctrl+K 全局命令面板
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setCmdPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <>
      <CommandPalette open={cmdPaletteOpen} onClose={() => setCmdPaletteOpen(false)} />
      <SessionExportDrawer
        session={exportSession}
        open={!!exportSession}
        onClose={() => setExportSession(null)}
      />
      <div className="app-frame">
        <header className="titlebar glass-panel">
          <div className="titlebar__inner">
            <div className="titlebar__meta">
              <div className="titlebar__brand">
                <img src="./images/logo.png" alt="" className="titlebar__logo" />
                <p className="section-title">One</p>
              </div>
            </div>
          </div>
        </header>

        <div
          className="app-shell"
          style={{ gridTemplateColumns: showSideList ? '56px 220px minmax(0,1fr)' : '56px minmax(0,1fr)' }}
        >
          <aside className="icon-rail">
            <div className="icon-rail__group">
              {navItems.map((item) => {
                const Icon = item.icon
                return (
                  <NavLink key={item.to} to={item.to} title={t(`common.pages.${item.key}`)}>
                    {({ isActive }) => (
                      <span className={`nav-button ${isActive ? 'nav-button--active' : ''}`}>
                        <Icon size={18} />
                      </span>
                    )}
                  </NavLink>
                )
              })}
            </div>
          </aside>

          {showSideList ? (
            <aside className="side-list">
              {/* 新建对话（横通栏主按钮） */}
              <button
                type="button"
                onClick={() => void newSession()}
                className="side-list__new"
              >
                <Plus size={16} />
                <span>{t('common:actions.newSession')}</span>
              </button>

              {/* 历史会话列表（紧凑，无卡片，hover 高亮） */}
              <div className="side-list__items">
                {recentItems.length === 0 ? (
                  <p className="side-list__empty">{t('common:empty.noSessions')}</p>
                ) : (
                  recentItems.map((s) => (
                    <div
                      key={s.id}
                      className={`side-list__item${currentSessionId === s.id ? ' side-list__item--active' : ''}`}
                    >
                      <button
                        type="button"
                        className="side-list__item-main"
                        onClick={() => void selectSession(s.id)}
                      >
                        <span className="side-list__item-title">{s.title}</span>
                        {s.updatedAt ? (
                          <span className="side-list__item-time">
                            {new Intl.DateTimeFormat(undefined, {
                              month: '2-digit',
                              day: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit',
                            }).format(s.updatedAt)}
                          </span>
                        ) : null}
                      </button>
                      <button
                        type="button"
                        className="side-list__item-delete"
                        title={t('common:actions.delete')}
                        aria-label={t('common:actions.delete')}
                        onClick={(e) => {
                          e.stopPropagation()
                          void (async () => {
                            const ok = await confirmDialog({
                              title: t('common:confirm.delete'),
                              confirmText: t('common:actions.delete'),
                            })
                            if (!ok) return
                            void removeSession(s.id).then(() => {
                              void qc.invalidateQueries({ queryKey: ['sessions'] })
                            })
                          })()
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                      <button
                        type="button"
                        className="side-list__item-export"
                        title={t('common:actions.export')}
                        aria-label={t('common:actions.export')}
                        onClick={(e) => {
                          e.stopPropagation()
                          setExportSession(s)
                        }}
                      >
                        <Download size={13} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </aside>
          ) : null}

          <main className="main-area">
            <div className={`main-content${isEditor ? ' main-content--canvas' : ''}`}>
              {/* 路由懒加载边界（§分包）：挂起只替换内容区，导航 chrome 保持挂载 */}
              <Suspense fallback={<PageLoading />}>
                <Outlet />
              </Suspense>
            </div>
            <aside className={`inspector ${showInspector ? 'inspector--open' : ''}`}>
              {showInspector ? (
                <div className="glass-panel" style={{ borderRadius: 24, padding: 20, height: 'calc(100vh - 88px)' }}>
                  <p className="section-title">{t('editor:inspector.title')}</p>
                  <p className="section-subtitle">{t('editor:inspector.subtitle')}</p>
                </div>
              ) : null}
            </aside>
          </main>
        </div>
      </div>
    </>
  )
}
