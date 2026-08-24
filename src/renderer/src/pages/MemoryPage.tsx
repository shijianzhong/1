import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Brain, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { errorMessage } from '@renderer/api/client'
import {
  useMemory,
  useMemoryL1Remove,
  useMemoryL2Remove,
  useMemoryL2Update,
  useMemoryL3Add,
  useMemoryL3Remove,
  useMemoryL3Update,
} from '@renderer/api/hooks'
import { Button } from '@renderer/components/ui/Button'
import { Input } from '@renderer/components/ui/Input'
import { Badge } from '@renderer/components/ui/Badge'
import { confirmDialog } from '@renderer/components/ui/ConfirmDialog'
import { EmptyState } from '@renderer/components/ui/EmptyState'
import { Field } from '@renderer/components/ui/Field'
import { PageToolbar } from '@renderer/components/ui/PageToolbar'
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
} from '@renderer/components/ui/Drawer'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/Tabs'

// —— 记忆管理页（§三之三 D + 铁律21）——
// 三个标签页：
//   L3 长期记忆（KV 原子事实）：新增 / 编辑 / 删除，key 前缀标识类别
//   L2 跨会话摘要：编辑文本 / 删除（会话结束自动精炼生成）
//   L1 会话摘要：仅查看 + 删除（LLM 滚动压缩产物，手动编辑会被下次压缩覆盖，故不提供编辑）

function formatTime(ts?: number): string {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return ''
  }
}

/** 从 L3 key 前缀解析类别（preference/identity/project/goal/fact） */
function categoryOf(key: string): string {
  const prefix = key.split(':')[0]?.toLowerCase() ?? ''
  if (['preference', 'identity', 'project', 'goal', 'fact'].includes(prefix)) return prefix
  return 'other'
}

interface L3Draft {
  key: string
  value: string
  originalKey: string | null
}

interface L2Draft {
  sessionId?: string
  ts: number
  digest: string
}

export function MemoryPage() {
  const { t } = useTranslation(['memory', 'common', 'errors'])
  const { data, isLoading } = useMemory()
  const snap = data ?? { l1: [], l2: [], l3: [] }

  const l3AddMut = useMemoryL3Add()
  const l3UpdateMut = useMemoryL3Update()
  const l3RemoveMut = useMemoryL3Remove()
  const l2UpdateMut = useMemoryL2Update()
  const l2RemoveMut = useMemoryL2Remove()
  const l1RemoveMut = useMemoryL1Remove()

  const [l3Query, setL3Query] = useState('')
  const [l3Draft, setL3Draft] = useState<L3Draft | null>(null)
  const [l2Draft, setL2Draft] = useState<L2Draft | null>(null)
  const [opError, setOpError] = useState<string | null>(null)

  const filteredL3 = useMemo(() => {
    const q = l3Query.trim().toLowerCase()
    if (!q) return snap.l3
    return snap.l3.filter(
      (f) => f.key.toLowerCase().includes(q) || f.value.toLowerCase().includes(q),
    )
  }, [snap.l3, l3Query])

  const onOpenL3Add = useCallback(() => {
    setOpError(null)
    setL3Draft({ key: '', value: '', originalKey: null })
  }, [])

  const onOpenL3Edit = useCallback((key: string, value: string) => {
    setOpError(null)
    setL3Draft({ key, value, originalKey: key })
  }, [])

  const onSaveL3 = useCallback(async (): Promise<void> => {
    if (!l3Draft) return
    const key = l3Draft.key.trim()
    const value = l3Draft.value.trim()
    if (!key || !value) return
    setOpError(null)
    try {
      if (l3Draft.originalKey && l3Draft.originalKey !== key) {
        // 改 key 身份：先建新条目再删旧（避免先删后建失败时丢失）
        await l3AddMut.mutateAsync({ key, value })
        await l3RemoveMut.mutateAsync({ key: l3Draft.originalKey })
      } else if (l3Draft.originalKey) {
        await l3UpdateMut.mutateAsync({ key, value })
      } else {
        await l3AddMut.mutateAsync({ key, value })
      }
      setL3Draft(null)
    } catch (err) {
      setOpError(errorMessage(err, t))
    }
  }, [l3Draft, l3AddMut, l3RemoveMut, l3UpdateMut, t])

  const onRemoveL3 = useCallback(
    async (key: string): Promise<void> => {
      const ok = await confirmDialog({
        title: t('memory:l3.removeConfirm'),
        confirmText: t('common:actions.delete'),
      })
      if (!ok) return
      setOpError(null)
      try {
        await l3RemoveMut.mutateAsync({ key })
      } catch (err) {
        setOpError(errorMessage(err, t))
      }
    },
    [l3RemoveMut, t],
  )

  const onOpenL2Edit = useCallback((entry: L2Draft): Promise<void> => {
    setOpError(null)
    setL2Draft({ ...entry })
    return Promise.resolve()
  }, [])

  const onSaveL2 = useCallback(async (): Promise<void> => {
    if (!l2Draft) return
    setOpError(null)
    try {
      await l2UpdateMut.mutateAsync(l2Draft)
      setL2Draft(null)
    } catch (err) {
      setOpError(errorMessage(err, t))
    }
  }, [l2Draft, l2UpdateMut, t])

  const onRemoveL2 = useCallback(
    async (entry: { sessionId?: string; ts: number }): Promise<void> => {
      const ok = await confirmDialog({
        title: t('memory:l2.removeConfirm'),
        confirmText: t('common:actions.delete'),
      })
      if (!ok) return
      setOpError(null)
      try {
        await l2RemoveMut.mutateAsync({ sessionId: entry.sessionId, ts: entry.ts })
      } catch (err) {
        setOpError(errorMessage(err, t))
      }
    },
    [l2RemoveMut, t],
  )

  const onRemoveL1 = useCallback(
    async (sessionId: string): Promise<void> => {
      const ok = await confirmDialog({
        title: t('memory:l1.removeConfirm'),
        confirmText: t('common:actions.delete'),
      })
      if (!ok) return
      setOpError(null)
      try {
        await l1RemoveMut.mutateAsync({ sessionId })
      } catch (err) {
        setOpError(errorMessage(err, t))
      }
    },
    [l1RemoveMut, t],
  )

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', display: 'grid', gap: 20 }}>
      <PageToolbar title={t('memory:title')} subtitle={t('memory:subtitle')} />

      {opError ? (
        <p role="alert" style={{ margin: 0, fontSize: '0.8rem', color: 'var(--color-danger)' }}>
          {t('memory:error', { message: opError })}
        </p>
      ) : null}

      <Tabs defaultValue="l3">
        <TabsList>
          <TabsTrigger value="l3">{t('memory:tab.l3')}</TabsTrigger>
          <TabsTrigger value="l2">{t('memory:tab.l2')}</TabsTrigger>
          <TabsTrigger value="l1">{t('memory:tab.l1')}</TabsTrigger>
        </TabsList>

        {/* —— L3 长期记忆 —— */}
        <TabsContent value="l3">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 12,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
              <Search
                size={15}
                style={{
                  position: 'absolute',
                  left: 10,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: 'var(--color-fg-muted)',
                }}
              />
              <Input
                value={l3Query}
                onChange={(e) => setL3Query(e.target.value)}
                placeholder={t('memory:l3.searchPh')}
                style={{ paddingLeft: 32 }}
              />
            </div>
            <Button onClick={onOpenL3Add}>
              <Plus size={16} /> {t('memory:l3.add')}
            </Button>
          </div>

          {isLoading ? (
            <p className="section-subtitle" style={{ margin: 0 }}>
              {t('common:state.loading')}
            </p>
          ) : filteredL3.length === 0 ? (
            <EmptyState title={t('memory:l3.empty')} icon={Brain} />
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {filteredL3.map((f) => (
                <div key={f.key} className="surface-panel" style={{ borderRadius: 14, padding: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <Badge variant="brand" style={{ fontSize: '0.7rem' }}>
                      {t(`memory:category.${categoryOf(f.key)}`)}
                    </Badge>
                    <code
                      style={{
                        fontSize: '0.78rem',
                        color: 'var(--color-fg-2)',
                        wordBreak: 'break-all',
                      }}
                    >
                      {f.key}
                    </code>
                    <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--color-fg-muted)' }}>
                      {formatTime(f.ts)}
                    </span>
                  </div>
                  <p
                    style={{
                      margin: 0,
                      fontSize: '0.85rem',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {f.value}
                  </p>
                  <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
                    <Button variant="ghost" size="sm" onClick={() => onOpenL3Edit(f.key, f.value)}>
                      <Pencil size={14} /> {t('common:actions.edit')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void onRemoveL3(f.key)}>
                      <Trash2 size={14} /> {t('common:actions.delete')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* —— L2 跨会话摘要 —— */}
        <TabsContent value="l2">
          <p style={{ fontSize: '0.78rem', color: 'var(--color-fg-3)', margin: '4px 0 12px' }}>
            {t('memory:l2.readOnlyNote')}
          </p>
          {isLoading ? (
            <p className="section-subtitle" style={{ margin: 0 }}>
              {t('common:state.loading')}
            </p>
          ) : snap.l2.length === 0 ? (
            <EmptyState title={t('memory:l2.empty')} icon={Brain} />
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {snap.l2.map((d) => (
                <div key={`${d.sessionId ?? ''}-${d.ts}`} className="surface-panel" style={{ borderRadius: 14, padding: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: '0.72rem', color: 'var(--color-fg-muted)' }}>
                      {t('memory:field.session')}: {d.sessionId ?? '—'}
                    </span>
                    <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--color-fg-muted)' }}>
                      {t('memory:field.updated')}: {formatTime(d.ts)}
                    </span>
                  </div>
                  <p style={{ margin: 0, fontSize: '0.85rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {d.digest}
                  </p>
                  <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void onOpenL2Edit({ sessionId: d.sessionId, ts: d.ts, digest: d.digest })}
                    >
                      <Pencil size={14} /> {t('common:actions.edit')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void onRemoveL2({ sessionId: d.sessionId, ts: d.ts })}
                    >
                      <Trash2 size={14} /> {t('common:actions.delete')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* —— L1 会话摘要（只读 + 删） —— */}
        <TabsContent value="l1">
          <p style={{ fontSize: '0.78rem', color: 'var(--color-fg-3)', margin: '4px 0 12px' }}>
            {t('memory:l1.readOnlyNote')}
          </p>
          {isLoading ? (
            <p className="section-subtitle" style={{ margin: 0 }}>
              {t('common:state.loading')}
            </p>
          ) : snap.l1.length === 0 ? (
            <EmptyState title={t('memory:l1.empty')} icon={Brain} />
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {snap.l1.map((s) => (
                <div key={s.sessionId} className="surface-panel" style={{ borderRadius: 14, padding: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: '0.72rem', color: 'var(--color-fg-muted)' }}>
                      {t('memory:field.session')}: {s.sessionId}
                    </span>
                    <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--color-fg-muted)' }}>
                      {formatTime(s.ts)}
                    </span>
                  </div>
                  <p
                    style={{
                      margin: 0,
                      fontSize: '0.85rem',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      color: 'var(--color-fg-2)',
                    }}
                  >
                    {s.summary}
                  </p>
                  <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
                    <Button variant="ghost" size="sm" onClick={() => void onRemoveL1(s.sessionId)}>
                      <Trash2 size={14} /> {t('common:actions.delete')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* L3 新增/编辑抽屉 */}
      <Drawer open={!!l3Draft} onOpenChange={(o) => !o && setL3Draft(null)}>
        <DrawerContent width={640}>
          {l3Draft ? (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
              <DrawerTitle>
                {l3Draft.originalKey ? t('memory:l3.editTitle') : t('memory:l3.addTitle')}
              </DrawerTitle>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 20, flex: 1, minHeight: 0 }}>
                <Field label={t('memory:l3.keyField')}>
                  <Input
                    value={l3Draft.key}
                    onChange={(e) => setL3Draft({ ...l3Draft, key: e.target.value })}
                    placeholder={t('memory:l3.keyPh')}
                    autoFocus
                  />
                </Field>
                <Field
                  label={t('memory:l3.valueField')}
                  style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
                >
                  <textarea
                    value={l3Draft.value}
                    onChange={(e) => setL3Draft({ ...l3Draft, value: e.target.value })}
                    style={{
                      flex: 1,
                      minHeight: 0,
                      resize: 'none',
                      width: '100%',
                      borderRadius: 10,
                      border: '1px solid var(--color-border-1)',
                      background: 'var(--color-bg-1)',
                      color: 'var(--color-fg-1)',
                      padding: 10,
                      fontSize: '0.85rem',
                      fontFamily: 'inherit',
                    }}
                    placeholder={t('memory:l3.valuePh')}
                  />
                </Field>
                {l3Draft.originalKey ? (
                  <p style={{ margin: 0, fontSize: '0.74rem', color: 'var(--color-fg-muted)' }}>
                    {t('memory:l3.renameHint')}
                  </p>
                ) : null}
                {opError ? (
                  <p role="alert" style={{ margin: 0, fontSize: '0.78rem', color: 'var(--color-danger)' }}>
                    {opError}
                  </p>
                ) : null}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexShrink: 0 }}>
                  <Button variant="ghost" onClick={() => setL3Draft(null)}>
                    {t('common:actions.cancel')}
                  </Button>
                  <Button
                    onClick={() => void onSaveL3()}
                    disabled={!l3Draft.key.trim() || !l3Draft.value.trim() || l3AddMut.isPending || l3UpdateMut.isPending}
                  >
                    {l3AddMut.isPending || l3UpdateMut.isPending
                      ? t('memory:l3.submitting')
                      : t('memory:l3.save')}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </DrawerContent>
      </Drawer>

      {/* L2 编辑抽屉 */}
      <Drawer open={!!l2Draft} onOpenChange={(o) => !o && setL2Draft(null)}>
        <DrawerContent width={640}>
          {l2Draft ? (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
              <DrawerTitle>{t('memory:l2.editTitle')}</DrawerTitle>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 20, flex: 1, minHeight: 0 }}>
                <Field
                  label={t('memory:l2.digestField')}
                  style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
                >
                  <textarea
                    value={l2Draft.digest}
                    onChange={(e) => setL2Draft({ ...l2Draft, digest: e.target.value })}
                    style={{
                      flex: 1,
                      minHeight: 0,
                      resize: 'none',
                      width: '100%',
                      borderRadius: 10,
                      border: '1px solid var(--color-border-1)',
                      background: 'var(--color-bg-1)',
                      color: 'var(--color-fg-1)',
                      padding: 10,
                      fontSize: '0.85rem',
                      fontFamily: 'inherit',
                    }}
                    placeholder={t('memory:l2.digestField')}
                  />
                </Field>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexShrink: 0 }}>
                  <Button variant="ghost" onClick={() => setL2Draft(null)}>
                    {t('common:actions.cancel')}
                  </Button>
                  <Button
                    onClick={() => void onSaveL2()}
                    disabled={!l2Draft.digest.trim() || l2UpdateMut.isPending}
                  >
                    {l2UpdateMut.isPending ? t('memory:l2.submitting') : t('memory:l2.save')}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </DrawerContent>
      </Drawer>
    </div>
  )
}
