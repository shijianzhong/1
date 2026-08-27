import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { ChevronDown, ChevronRight, Puzzle, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react'
import type { OnePluginManifest, PluginConfigField } from '@shared/types'
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

  const onTrust = async (p: OnePluginManifest): Promise<void> => {
    const trusted = p.trustedBy !== null && p.trustedBy !== undefined
    if (trusted) {
      // 取消信任：直接调（不二次确认，可再点回来）
      await window.one.plugins.trust(p.id, false).then(unwrap).catch(() => {})
    } else {
      // 信任：二次确认（B 工具将执行用户/AI 提供的代码，每次调用仍弹审批，但信任是不可逆的"放行"动作）
      if (!confirm(t('plugins:trustConfirm'))) return
      await window.one.plugins.trust(p.id, true).then(unwrap).catch(() => {})
    }
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
        const isGeneratedB = p.kind === 'generated_b'
        const isExternal = p.kind === 'external'
        const isCodePlugin = isGeneratedB || isExternal
        const isExpandable = isGenerated || isCodePlugin
        const isToggleable = isGenerated || isCodePlugin || p.kind === 'skill'
        const isBuiltin = p.kind === 'builtin'
        const isOpen = expanded === p.id
        const isTrusted = p.trustedBy !== null && p.trustedBy !== undefined
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
                {isExpandable ? (
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
                <span style={{ fontWeight: 500, fontSize: '0.88rem' }}>{isBuiltin ? t('plugins:builtin.name') : p.name}</span>
                <Badge variant="default">{t(`plugins:kind.${p.kind}`)}</Badge>
                {p.enabled ? (
                  <Badge variant="success">{t('plugins:enabled')}</Badge>
                ) : (
                  <Badge variant="default">{t('plugins:disabled')}</Badge>
                )}
                {/* B 专属：信任态徽标（未信任显眼提示用户去信任） */}
                {isCodePlugin ? (
                  isTrusted ? (
                    <Badge variant="success">{t('plugins:trusted')}</Badge>
                  ) : (
                    <Badge variant="warning">{t('plugins:untrusted')}</Badge>
                  )
                ) : null}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {isToggleable && <Switch checked={p.enabled} onCheckedChange={() => void onToggle(p)} />}
                {/* B 专属：信任/取消信任按钮（信任前不卸载代码，可随时切回占位） */}
                {isCodePlugin ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void onTrust(p)}
                    title={t('plugins:trust')}
                  >
                    {isTrusted ? <ShieldOff size={14} /> : <ShieldCheck size={14} />}
                  </Button>
                ) : null}
                {isExpandable ? (
                  <Button variant="ghost" size="sm" onClick={() => void onUninstall(p)}>
                    <Trash2 size={14} />
                  </Button>
                ) : null}
              </div>
            </div>

            {/* 摘要行 */}
            <div style={{ fontSize: '0.78rem', color: 'var(--color-fg-3)' }}>
              {isBuiltin
                ? t('plugins:builtin.desc')
                : p.description || t('plugins:noDescription')}
              {p.effects.tools.length > 0
                ? ` · ${t('plugins:tools', { count: p.effects.tools.length })}`
                : ''}
              {/* B 未信任时附引导语 */}
              {isCodePlugin && !isTrusted ? ` · ${t('plugins:untrustedHint')}` : ''}
            </div>

            {/* generated/A 展开详情：manifest spec */}
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

            {/* generated/B / external 展开详情：handlerSource 源码 + trustedBy 事实（同代码型结构） */}
            {isCodePlugin && isOpen && (p.specB || p.specExternal) ? (
              (() => {
                const spec = (p.specB ?? p.specExternal)!
                const toolPrefix = isGeneratedB ? `generated_b/${spec.name}` : `external/${spec.name}`
                return (
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
                <SpecRow label={t('plugins:spec.toolName')} value={toolPrefix} />
                <SpecRow
                  label={t('plugins:trustedBy')}
                  value={
                    p.trustedBy
                      ? `${t('plugins:trusted')} · ${new Date(p.trustedBy.ts).toLocaleString()}`
                      : t('plugins:untrusted')
                  }
                />
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
                      maxHeight: 160,
                    }}
                  >
                    {JSON.stringify(spec.inputSchema, null, 2)}
                  </pre>
                </div>
                <div>
                  <div style={{ color: 'var(--color-fg-3)', marginBottom: 4 }}>
                    {t('plugins:spec.handlerSource')}
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      padding: 8,
                      borderRadius: 6,
                      background: 'var(--color-bg-1)',
                      border: '1px solid var(--color-border)',
                      overflow: 'auto',
                      fontSize: '0.72rem',
                      lineHeight: 1.5,
                      maxHeight: 280,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                    }}
                  >
                    {spec.handlerSource}
                  </pre>
                </div>
              </div>
                )
              })()
            ) : null}

            {/* 配置项声明（插件 configSchema，只读展示；secret 字段仅显示 vault keyId，明文不落渲染层） */}
            {isOpen && p.configSchema && p.configSchema.length > 0 ? (
              <ConfigSchemaBlock fields={p.configSchema} t={t} />
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

/** 插件配置项声明（configSchema）只读展示；secret 字段只暴露 vault keyId（明文不落渲染层，铁律3） */
function ConfigSchemaBlock({ fields, t }: { fields: PluginConfigField[]; t: TFunction }) {
  return (
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
      <div style={{ color: 'var(--color-fg-3)', marginBottom: 4 }}>{t('plugins:config.title')}</div>
      {fields.map((f, i) => (
        <div
          key={i}
          style={{
            display: 'grid',
            gap: 4,
            padding: 8,
            borderRadius: 6,
            background: 'var(--color-bg-1)',
            border: '1px solid var(--color-border)',
          }}
        >
          <SpecRow label={t('plugins:config.name')} value={f.name} />
          <SpecRow label={t('plugins:config.type')} value={f.type} />
          {f.description ? (
            <SpecRow label={t('plugins:config.desc')} value={f.description} />
          ) : null}
          {f.secret ? (
            <SpecRow
              label={t('plugins:config.secret')}
              value={f.secretBound ? `vault:${f.vaultKeyId}` : t('plugins:config.noKeyId')}
            />
          ) : null}
        </div>
      ))}
    </div>
  )
}
