import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plug, PlugZap, Plus, Trash2, Pencil } from 'lucide-react'
import type { McpServerConfig, McpServerStatus } from '@shared/types'
import { unwrap } from '@renderer/api/client'
import { Badge } from '@renderer/components/ui/Badge'
import { Button } from '@renderer/components/ui/Button'
import { Input } from '@renderer/components/ui/Input'
import { Switch } from '@renderer/components/ui/Switch'

// —— 设置页 MCP 服务器管理区 ——
// 列出所有已配置的 MCP 服务器，支持添加/编辑/删除/连接/断开/测试连接。
// 配置持久化在 config/mcp-servers.json，连接状态运行时维护。

type EditState = {
  id?: string // 有 id = 编辑模式，无 = 新增模式
  name: string
  transport: 'stdio' | 'http'
  command: string
  args: string
  url: string
  enabled: boolean
  approvalMode: 'always' | 'auto'
}

const EMPTY_EDIT: EditState = {
  name: '',
  transport: 'stdio',
  command: '',
  args: '',
  url: '',
  enabled: true,
  approvalMode: 'always',
}

export function McpSettings() {
  const { t } = useTranslation(['settings', 'common'])
  const [servers, setServers] = useState<McpServerStatus[]>([])
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState<EditState | null>(null)
  const [testMsg, setTestMsg] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.one.mcp.listServers().then(unwrap)
      setServers(list)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const startAdd = (): void => {
    setEditing({ ...EMPTY_EDIT })
    setTestMsg(null)
  }

  const startEdit = (s: McpServerStatus): void => {
    setEditing({
      id: s.config.id,
      name: s.config.name,
      transport: s.config.transport,
      command: s.config.command ?? '',
      args: s.config.args?.join(' ') ?? '',
      url: s.config.url ?? '',
      enabled: s.config.enabled,
      approvalMode: s.config.approvalMode ?? 'always',
    })
    setTestMsg(null)
  }

  const cancelEdit = (): void => {
    setEditing(null)
    setTestMsg(null)
  }

  const validate = (e: EditState): string | null => {
    if (!e.name.trim()) return t('settings:mcp.nameRequired')
    if (e.transport === 'stdio' && !e.command.trim()) return t('settings:mcp.commandRequired')
    if (e.transport === 'http' && !e.url.trim()) return t('settings:mcp.urlRequired')
    return null
  }

  const buildConfig = (e: EditState): Omit<McpServerConfig, 'id'> => ({
    name: e.name.trim(),
    transport: e.transport,
    command: e.transport === 'stdio' ? e.command.trim() : undefined,
    args: e.transport === 'stdio' && e.args.trim() ? e.args.trim().split(/\s+/) : undefined,
    url: e.transport === 'http' ? e.url.trim() : undefined,
    enabled: e.enabled,
    approvalMode: e.approvalMode,
  })

  const onSave = async (): Promise<void> => {
    if (!editing) return
    const err = validate(editing)
    if (err) {
      setTestMsg(err)
      return
    }
    try {
      if (editing.id) {
        await window.one.mcp
          .updateServer({ id: editing.id, ...buildConfig(editing) })
          .then(unwrap)
      } else {
        await window.one.mcp.addServer(buildConfig(editing)).then(unwrap)
      }
      setEditing(null)
      await refresh()
    } catch (e) {
      setTestMsg(e instanceof Error ? e.message : String(e))
    }
  }

  const onTest = async (): Promise<void> => {
    if (!editing) return
    const err = validate(editing)
    if (err) {
      setTestMsg(err)
      return
    }
    setTesting(true)
    setTestMsg(null)
    try {
      const result = await window.one.mcp.testServer(buildConfig(editing)).then(unwrap)
      setTestMsg(t('settings:mcp.testSuccess', { count: result.toolCount }))
    } catch (e) {
      setTestMsg(t('settings:mcp.testFailed', { message: e instanceof Error ? e.message : String(e) }))
    } finally {
      setTesting(false)
    }
  }

  const onRemove = async (id: string): Promise<void> => {
    if (!confirm(t('settings:mcp.removeConfirm'))) return
    await window.one.mcp.removeServer(id).then(unwrap).catch(() => {})
    await refresh()
  }

  const onToggleConnect = async (s: McpServerStatus): Promise<void> => {
    try {
      if (s.connected) {
        await window.one.mcp.disconnectServer(s.config.id).then(unwrap)
      } else {
        await window.one.mcp.connectServer(s.config.id).then(unwrap)
      }
      await refresh()
    } catch {
      // refresh 仍刷新状态
      await refresh()
    }
  }

  // —— 编辑/新增表单 ——
  if (editing) {
    const update = (patch: Partial<EditState>): void => setEditing((p) => (p ? { ...p, ...patch } : p))
    return (
      <div style={{ display: 'grid', gap: 12 }}>
        <Row label={t('settings:mcp.name')}>
          <Input
            value={editing.name}
            onChange={(e) => update({ name: e.target.value })}
            style={{ width: 240 }}
          />
        </Row>
        <Row label={t('settings:mcp.transport')}>
          <select
            value={editing.transport}
            onChange={(e) => update({ transport: e.target.value as 'stdio' | 'http' })}
            style={selectStyle}
          >
            <option value="stdio">{t('settings:mcp.stdio')}</option>
            <option value="http">{t('settings:mcp.http')}</option>
          </select>
        </Row>
        {editing.transport === 'stdio' ? (
          <>
            <Row label={t('settings:mcp.command')}>
              <Input
                value={editing.command}
                onChange={(e) => update({ command: e.target.value })}
                placeholder={t('settings:mcp.commandPh')}
                style={{ width: 240 }}
              />
            </Row>
            <Row label={t('settings:mcp.args')}>
              <Input
                value={editing.args}
                onChange={(e) => update({ args: e.target.value })}
                placeholder={t('settings:mcp.argsPh')}
                style={{ width: 320 }}
              />
            </Row>
          </>
        ) : (
          <Row label={t('settings:mcp.url')}>
            <Input
              value={editing.url}
              onChange={(e) => update({ url: e.target.value })}
              placeholder={t('settings:mcp.urlPh')}
              style={{ width: 320 }}
            />
          </Row>
        )}
        <Row label={t('settings:mcp.enabled')}>
          <Switch
            checked={editing.enabled}
            onCheckedChange={(c) => update({ enabled: c })}
          />
        </Row>
        <Row label={t('settings:mcp.approvalMode')}>
          <select
            value={editing.approvalMode}
            onChange={(e) => update({ approvalMode: e.target.value as 'always' | 'auto' })}
            style={selectStyle}
          >
            <option value="always">{t('settings:mcp.approvalAlways')}</option>
            <option value="auto">{t('settings:mcp.approvalAuto')}</option>
          </select>
        </Row>
        {testMsg ? (
          <p style={{ fontSize: '0.8rem', color: testMsg.includes(t('settings:mcp.testSuccess', { count: 0 }).split('{{count}}')[0]) ? 'var(--color-success)' : 'var(--color-danger)' }}>
            {testMsg}
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="secondary" size="sm" onClick={() => void onSave()}>
            {t('settings:mcp.save')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void onTest()} disabled={testing}>
            {testing ? t('settings:mcp.testing') : t('settings:mcp.test')}
          </Button>
          <Button variant="ghost" size="sm" onClick={cancelEdit}>
            {t('settings:mcp.cancel')}
          </Button>
        </div>
      </div>
    )
  }

  // —— 服务器列表 ——
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {servers.length === 0 && !loading ? (
        <p style={{ color: 'var(--color-fg-3)', fontSize: '0.85rem' }}>{t('settings:mcp.empty')}</p>
      ) : null}
      {servers.map((s) => (
        <div
          key={s.config.id}
          className="asset-card"
          style={{
            padding: 12,
            borderRadius: 12,
            border: '1px solid var(--color-border)',
            background: 'var(--color-bg-1)',
            display: 'grid',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {s.connected ? (
                <PlugZap size={16} style={{ color: 'var(--color-success)' }} />
              ) : (
                <Plug size={16} style={{ color: 'var(--color-fg-3)' }} />
              )}
              <span style={{ fontWeight: 500, fontSize: '0.88rem' }}>{s.config.name}</span>
              <Badge variant={s.connected ? 'success' : 'default'}>
                {s.connected ? t('settings:mcp.connected') : t('settings:mcp.disconnected')}
              </Badge>
              {s.connected ? (
                <span style={{ fontSize: '0.75rem', color: 'var(--color-fg-3)' }}>
                  {t('settings:mcp.tools', { count: s.toolCount })}
                </span>
              ) : null}
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void onToggleConnect(s)}
              >
                {s.connected ? t('settings:mcp.disconnect') : t('settings:mcp.connect')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => startEdit(s)}>
                <Pencil size={14} />
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void onRemove(s.config.id)}>
                <Trash2 size={14} />
              </Button>
            </div>
          </div>
          <div style={{ fontSize: '0.78rem', color: 'var(--color-fg-3)' }}>
            {s.config.transport === 'stdio'
              ? `${s.config.command} ${(s.config.args ?? []).join(' ')}`
              : s.config.url}
            {s.config.enabled ? ` · ${t('settings:mcp.enabled')}` : ''}
          </div>
        </div>
      ))}
      <Button variant="secondary" size="sm" onClick={startAdd}>
        <Plus size={14} /> {t('settings:mcp.add')}
      </Button>
    </div>
  )
}

const selectStyle: React.CSSProperties = {
  height: 36,
  borderRadius: 12,
  border: '1px solid var(--color-border)',
  background: 'var(--color-bg-1)',
  color: 'var(--color-fg-1)',
  padding: '0 10px',
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        minHeight: 40,
        borderBottom: '1px solid var(--color-border)',
      }}
    >
      <span style={{ fontSize: '0.875rem', color: 'var(--color-fg-2)' }}>{label}</span>
      {children}
    </div>
  )
}
