import { useEffect, useMemo, useState } from 'react'
import {
  Bot,
  Boxes,
  Cable,
  Command,
  Settings,
  Sparkles,
  Wrench,
} from 'lucide-react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useSessions } from '@renderer/api/hooks'

const navItems = [
  { to: '/', key: 'home', icon: Sparkles },
  { to: '/editor', key: 'editor', icon: Boxes },
  { to: '/agents', key: 'agents', icon: Bot },
  { to: '/skills', key: 'skills', icon: Wrench },
  { to: '/models', key: 'models', icon: Cable },
  { to: '/tasks', key: 'tasks', icon: Command },
  { to: '/settings', key: 'settings', icon: Settings },
] as const

export function AppShell() {
  const { t } = useTranslation(['common', 'editor', 'home'])
  const location = useLocation()
  const [commandOpen, setCommandOpen] = useState(false)

  const showSideList = location.pathname === '/'
  const showInspector = location.pathname.startsWith('/editor')
  const currentPage = navItems.find((item) => item.to === location.pathname) ?? navItems[0]
  const sessionsQ = useSessions()
  const recentItems = useMemo(
    () => (sessionsQ.data ?? []).map((s) => s.title).slice(0, 5),
    [sessionsQ.data],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen((open) => !open)
      }

      if (event.key === 'Escape') {
        setCommandOpen(false)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <>
      <div className="app-frame">
        <header className="titlebar glass-panel">
          <div className="titlebar__inner">
            <div className="titlebar__meta">
              <p className="section-title">{t(`common.pages.${currentPage.key}`)}</p>
              <p className="section-subtitle">{t('common.appName')}</p>
            </div>
            <button type="button" className="nav-button titlebar__command" onClick={() => setCommandOpen(true)}>
              <Command size={18} />
            </button>
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
              <div>
                <p className="section-title">{t('common.appName')}</p>
                <p className="section-subtitle">{t('common.subtitle')}</p>
              </div>
              <div style={{ display: 'grid', gap: 10 }}>
                {recentItems.map((item) => (
                  <div key={item} className="surface-panel" style={{ borderRadius: 18, padding: 14 }}>
                    <p className="section-title">{item}</p>
                  </div>
                ))}
              </div>
            </aside>
          ) : null}

          <main className="main-area">
            <div className="main-content">
              <Outlet />
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

      {commandOpen ? (
        <div className="command-overlay" onClick={() => setCommandOpen(false)}>
          <div className="glass-panel command-panel" onClick={(event) => event.stopPropagation()}>
            <input className="command-input" autoFocus placeholder={t('common.command.title')} />
            <div style={{ display: 'grid', gap: 8, marginTop: 16 }}>
              {navItems.map((item) => (
                <NavLink
                  key={`command-${item.to}`}
                  className="route-link"
                  to={item.to}
                  onClick={() => setCommandOpen(false)}
                >
                  <span>{t(`common.pages.${item.key}`)}</span>
                  <span style={{ color: 'var(--color-fg-2)' }}>{t('common.command.hint')}</span>
                </NavLink>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
