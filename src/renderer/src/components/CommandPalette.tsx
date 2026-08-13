import { useState, useMemo, useEffect, useRef, type ComponentType } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Search, MessageSquare, Bot, Wrench, Boxes, Sparkles, Cable, Plug, Command, Settings, Store,
} from 'lucide-react'
import { useSessions } from '@renderer/api/hooks'
import { useAgents } from '@renderer/api/hooks'
import { useSkills } from '@renderer/api/hooks'
import { useCapabilities } from '@renderer/api/hooks'
import { useChatStore } from '@renderer/store/chat'

// —— 页面导航项（与 AppShell navItems 一致）——
const NAV_ITEMS = [
  { to: '/', key: 'home', icon: Sparkles },
  { to: '/capabilities', key: 'capabilities', icon: Boxes },
  { to: '/agents', key: 'agents', icon: Bot },
  { to: '/skills', key: 'skills', icon: Wrench },
  { to: '/registry', key: 'registry', icon: Store },
  { to: '/models', key: 'models', icon: Cable },
  { to: '/mcp', key: 'mcp', icon: Plug },
  { to: '/tasks', key: 'tasks', icon: Command },
  { to: '/settings', key: 'settings', icon: Settings },
] as const

interface CommandItem {
  id: string
  label: string
  description?: string
  icon: ComponentType<{ size?: number }>
  group: 'navigation' | 'sessions' | 'agents' | 'skills' | 'capabilities'
  action: () => void
  _idx?: number  // 分组后携带的扁平索引，用于键盘导航
}

const GROUP_ORDER: CommandItem['group'][] = ['navigation', 'sessions', 'agents', 'capabilities', 'skills']
const GROUP_LABEL_KEY: Record<CommandItem['group'], string> = {
  navigation: 'common:command.navigation',
  sessions: 'common:command.sessions',
  agents: 'common:command.agents',
  capabilities: 'common:command.capabilities',
  skills: 'common:command.skills',
}

/**
 * 全局命令面板：Cmd+K / Ctrl+K 触发，搜索会话/Agent/Skill/Capability/页面导航。
 *
 * 数据来源：useSessions（会话）+ useAgents/useSkills/useCapabilities（React Query 缓存）。
 * 键盘导航：↑↓ 选择，Enter 确认，Esc 关闭。
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation(['common'])
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // 数据来源
  const sessionsQ = useSessions()
  const agentsQ = useAgents()
  const skillsQ = useSkills()
  const capabilitiesQ = useCapabilities()
  const chatSessions = useChatStore((s) => s.sessions)
  const selectSession = useChatStore((s) => s.selectSession)

  // 构建搜索项
  const items = useMemo<CommandItem[]>(() => {
    const result: CommandItem[] = []

    // 页面导航
    for (const item of NAV_ITEMS) {
      result.push({
        id: `nav-${item.key}`,
        label: t(`common:pages.${item.key}`),
        icon: item.icon,
        group: 'navigation',
        action: () => navigate(item.to),
      })
    }

    // 会话（仅主 Agent 会话，排除编辑器试跑）
    const sessionList = chatSessions.length ? chatSessions : sessionsQ.data ?? []
    for (const s of sessionList.filter((s) => !s.capabilityId).slice(0, 20)) {
      result.push({
        id: `session-${s.id}`,
        label: s.title,
        icon: MessageSquare,
        group: 'sessions',
        action: () => {
          navigate('/')
          void selectSession(s.id)
        },
      })
    }

    // Agent
    for (const a of agentsQ.data ?? []) {
      result.push({
        id: `agent-${a.id}`,
        label: a.name,
        description: a.description,
        icon: Bot,
        group: 'agents',
        action: () => navigate('/agents'),
      })
    }

    // Capability
    for (const c of capabilitiesQ.data ?? []) {
      result.push({
        id: `cap-${c.id}`,
        label: c.name,
        description: c.description,
        icon: Boxes,
        group: 'capabilities',
        action: () => navigate('/capabilities'),
      })
    }

    // Skill
    for (const s of skillsQ.data ?? []) {
      result.push({
        id: `skill-${s.id}`,
        label: s.name,
        description: s.description,
        icon: Wrench,
        group: 'skills',
        action: () => navigate('/skills'),
      })
    }

    // 过滤
    if (!query.trim()) return result.slice(0, 20)
    const q = query.toLowerCase()
    return result.filter((item) =>
      item.label.toLowerCase().includes(q) ||
      item.description?.toLowerCase().includes(q),
    )
  }, [query, chatSessions, sessionsQ.data, agentsQ.data, capabilitiesQ.data, skillsQ.data, navigate, selectSession, t])

  // 重置选中项
  useEffect(() => {
    setSelectedIdx(0)
  }, [query])

  // 打开时聚焦输入框
  useEffect(() => {
    if (open) {
      setQuery('')
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // 键盘导航
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx((i) => Math.min(i + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = items[selectedIdx]
      if (item) {
        item.action()
        onClose()
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  // 滚动选中项到可见区
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${selectedIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  // 分组（必须在 early return 之前调用，遵守 Hooks 规则）
  const grouped = useMemo(() => {
    const map = new Map<CommandItem['group'], CommandItem[]>()
    items.forEach((item, idx) => {
      const arr = map.get(item.group) ?? []
      arr.push({ ...item, _idx: idx })
      map.set(item.group, arr)
    })
    return GROUP_ORDER
      .filter((g) => map.has(g))
      .map((g) => ({ group: g, items: map.get(g)! }))
  }, [items])

  if (!open) return null

  return (
    <div className="cmd-palette" onKeyDown={handleKeyDown}>
      <div className="cmd-palette__overlay" onClick={onClose} />
      <div className="cmd-palette__panel">
        <div className="cmd-palette__search">
          <Search size={16} className="cmd-palette__search-icon" />
          <input
            ref={inputRef}
            className="cmd-palette__input"
            placeholder={t('common:command.title')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd className="cmd-palette__kbd">Esc</kbd>
        </div>

        <div className="cmd-palette__list" ref={listRef}>
          {items.length === 0 ? (
            <div className="cmd-palette__empty">{t('common:command.empty')}</div>
          ) : (
            grouped.map(({ group, items: groupItems }) => (
              <div key={group} className="cmd-palette__group">
                <div className="cmd-palette__group-label">
                  {t(GROUP_LABEL_KEY[group])}
                </div>
                {groupItems.map((item) => {
                  const Icon = item.icon
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`cmd-palette__item ${item._idx === selectedIdx ? 'cmd-palette__item--active' : ''}`}
                      data-idx={item._idx}
                      onMouseEnter={() => setSelectedIdx(item._idx ?? 0)}
                      onClick={() => {
                        item.action()
                        onClose()
                      }}
                    >
                      <Icon size={14} />
                      <span className="cmd-palette__item-label">{item.label}</span>
                      {item.description ? (
                        <span className="cmd-palette__item-desc">{item.description}</span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
