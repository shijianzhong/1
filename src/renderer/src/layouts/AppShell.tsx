import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Bot,
  Boxes,
  Cable,
  Command,
  Settings,
  Sparkles,
  Wrench,
} from 'lucide-react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
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
  const navigate = useNavigate()
  const [commandOpen, setCommandOpen] = useState(false)
  const [commandQuery, setCommandQuery] = useState('')
  const [commandIndex, setCommandIndex] = useState(0)

  const showSideList = location.pathname === '/'
  const isEditor = location.pathname.startsWith('/editor')
  const showInspector = false
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
            <div className={`main-content${isEditor ? ' main-content--canvas' : ''}`}>
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
        <motion.div
          className="command-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={() => setCommandOpen(false)}
        >
          <div className="glass-panel command-panel" onClick={(event) => event.stopPropagation()}>
            <input
              className="command-input"
              autoFocus
              placeholder={t('common.command.title')}
              value={commandQuery}
              onChange={(e) => {
                setCommandQuery(e.target.value)
                setCommandIndex(0)
              }}
              onKeyDown={(e) => {
                const filtered = filteredNav(navItems, commandQuery, t)
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setCommandIndex((i) => (i + 1) % Math.max(filtered.length, 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setCommandIndex((i) => (i - 1 + Math.max(filtered.length, 1)) % Math.max(filtered.length, 1))
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  const target = filtered[commandIndex]
                  if (target) {
                    void navigate(target.to)
                    setCommandOpen(false)
                    setCommandQuery('')
                  }
                }
              }}
            />
            <div style={{ display: 'grid', gap: 8, marginTop: 16 }}>
              {filteredNav(navItems, commandQuery, t).map((item, i) => (
                <button
                  key={`command-${item.to}`}
                  type="button"
                  className="route-link"
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    width: '100%',
                    background:
                      i === commandIndex ? 'var(--color-bg-3)' : 'transparent',
                    borderLeft:
                      i === commandIndex ? '2px solid var(--color-brand-500)' : '2px solid transparent',
                  }}
                  onMouseEnter={() => setCommandIndex(i)}
                  onClick={() => {
                    void navigate(item.to)
                    setCommandOpen(false)
                    setCommandQuery('')
                  }}
                >
                  <span>{t(`common.pages.${item.key}`)}</span>
                  <span style={{ color: 'var(--color-fg-2)' }}>{t('common.command.hint')}</span>
                </button>
              ))}
            </div>
          </div>
        </motion.div>
      ) : null}
    </>
  )
}

/** 命令面板搜索过滤（按 i18n 标题匹配） */
function filteredNav(
  items: ReadonlyArray<(typeof navItems)[number]>,
  query: string,
  t: (key: string) => string,
): Array<(typeof navItems)[number]> {
  const q = query.trim().toLowerCase()
  if (!q) return [...items]
  return items.filter((item) =>
    t(`common.pages.${item.key}`).toLowerCase().includes(q),
  )
}
