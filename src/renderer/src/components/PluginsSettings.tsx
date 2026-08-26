import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Puzzle, Trash2 } from 'lucide-react'
import type { OnePluginManifest } from '@shared/types'
import { unwrap } from '@renderer/api/client'
import { Badge } from '@renderer/components/ui/Badge'
import { Button } from '@renderer/components/ui/Button'
import { Switch } from '@renderer/components/ui/Switch'

// —— 插件管理面板（由 PluginsPage 承载）——
// 列出 generated/A 声明式工具 + skill，支持启停（Switch）+ 卸载 + 展开 manifest 详情。
// generated 行可展开看 spec（name/description/inputSchema/executeAction 白名单 action），
// 让"造完不是黑盒"。

export function PluginsSettings() {
  const { t } = useTranslation(['plugins', 'common'])
  const [plugins, setPlugins] = useState<OnePluginManifest[]>([])
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.one.plugins.list().then(unwrap)
      setPlugins(list)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const onToggle = async (p: OnePluginManifest): Promise<void> => {
    try {
      if (p.enabled) {
        await window.one.plugins.disable(p.id).then(unwrap)
      } else {
        await window.one.plugins.enable(p.id).then(unwrap)
      }
      await refresh()
    } catch {
      await refresh()
    }
  }

  const onUninstall = async (p: OnePluginManifest): Promise<void> => {
    if (!confirm(t('plugins:removeConfirm'))) return
    await window.one.plugins.uninstall(p.id).then(unwrap).catch(() => {})
    await refresh()
  }

  if (plugins.length === 0 && !loading) {
    return (
      <p style={{ color: 'var(--color-fg-3)', fontSize: '0.85rem' }}>{t('plugins:empty')}</p>
    )
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {plugins.map((p) => {
        const isGenerated = p.kind === 'generated'
        const isOpen = expanded === p.id
        return (
          <div
            key={p.id}
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
                {isGenerated ? (
                  <span
                    style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                    onClick={() => setExpanded(isOpen ? null : p.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') setExpanded(isOpen ? null : p.id)
                    }}
                  >
                    {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </span>
                ) : (
                  <Puzzle size={16} style={{ color: 'var(--color-fg-3)' }} />
                )}
                <span style={{ fontWeight: 500, fontSize: '0.88rem' }}>{p.name}</span>
                <Badge variant="default">{t(`plugins:kind.${p.kind}`)}</Badge>
                {p.enabled ? (
                  <Badge variant="success">{t('plugins:enabled')}</Badge>
                ) : (
                  <Badge variant="default">{t('plugins:disabled')}</Badge>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Switch checked={p.enabled} onCheckedChange={() => void onToggle(p)} />
                {isGenerated ? (
                  <Button variant="ghost" size="sm" onClick={() => void onUninstall(p)}>
                    <Trash2 size={14} />
                  </Button>
                ) : null}
              </div>
            </div>

            {/* 摘要行 */}
            <div style={{ fontSize: '0.78rem', color: 'var(--color-fg-3)' }}>
              {p.description || t('plugins:noDescription')}
              {p.effects.tools.length > 0
                ? ` · ${t('plugins:tools', { count: p.effects.tools.length })}`
                : ''}
            </div>

            {/* generated 展开详情：manifest spec */}
            {isGenerated && isOpen && p.spec ? (
              <div
                style={{
                  marginTop: 4,
                  padding: 10,
                  borderRadius: 8,
                  background: 'var(--color-bg-2)',
                  border: '1px solid var(--color-border)',
                  display: 'grid',
                  gap: 6,
                  fontSize: '0.78rem',
                }}
              >
                <SpecRow label={t('plugins:spec.toolName')} value={`generated/${p.spec.name}`} />
                <SpecRow label={t('plugins:spec.action')} value={p.spec.executeAction.action} />
                {p.spec.executeAction.params ? (
                  <SpecRow
                    label={t('plugins:spec.fixedParams')}
                    value={JSON.stringify(p.spec.executeAction.params)}
                  />
                ) : null}
                <div>
                  <div style={{ color: 'var(--color-fg-3)', marginBottom: 4 }}>
                    {t('plugins:spec.inputSchema')}
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      padding: 8,
                      borderRadius: 6,
                      background: 'var(--color-bg-1)',
                      overflow: 'auto',
                      fontSize: '0.72rem',
                      lineHeight: 1.5,
                      maxHeight: 240,
                    }}
                  >
                    {JSON.stringify(p.spec.inputSchema, null, 2)}
                  </pre>
                </div>
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
      <span style={{ color: 'var(--color-fg-3)', minWidth: 96, flexShrink: 0 }}>{label}</span>
      <span style={{ wordBreak: 'break-all' }}>{value}</span>
    </div>
  )
}
