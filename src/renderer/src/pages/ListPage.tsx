import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Pencil } from 'lucide-react'
import {
  useProviders,
  useRemoveProvider,
  useRemoveSkill,
  useSaveProvider,
  useSaveSkill,
  useSkills,
} from '@renderer/api/hooks'
import { unwrap } from '@renderer/api/client'
import { Button } from '@renderer/components/ui/Button'
import { Input } from '@renderer/components/ui/Input'
import { Switch } from '@renderer/components/ui/Switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@renderer/components/ui/Table'
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
} from '@renderer/components/ui/Drawer'
import { Badge } from '@renderer/components/ui/Badge'
import { confirmDialog } from '@renderer/components/ui/ConfirmDialog'
import { EmptyState } from '@renderer/components/ui/EmptyState'
import { Field } from '@renderer/components/ui/Field'
import { PageToolbar } from '@renderer/components/ui/PageToolbar'
import type {
  ApiFormat,
  Provider,
  Skill,
} from '@shared/types'

// —— 管理后台列表（§3 + §5.5）——
// skills 用 Table + Drawer 编辑（name + 内容字段）；
// models 用供应商为中心（cc switch 范式）：列出供应商，编辑含用途模型。
// agents 已移至独立的 AgentsPage。

interface ListPageProps {
  i18nKey: 'skills' | 'models'
}

export function ListPage({ i18nKey }: ListPageProps) {
  const { t } = useTranslation(['common'])
  const title = t(`common:list.${i18nKey}.title`)
  const description = t(`common:list.${i18nKey}.description`)

  const skillsQ = useSkills()
  const providersQ = useProviders()

  const saveSkill = useSaveSkill()
  const saveProvider = useSaveProvider()
  const removeSkill = useRemoveSkill()
  const removeProvider = useRemoveProvider()

  const [draft, setDraft] = useState<Draft | null>(null)
  const items =
    i18nKey === 'skills'
      ? skillsQ.data ?? []
      : providersQ.data ?? []

  const query = i18nKey === 'skills' ? skillsQ : providersQ

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', display: 'grid', gap: 20 }}>
      {/* 顶部工具条 */}
      <PageToolbar
        title={title}
        subtitle={description}
        actions={
          <Button
            onClick={() =>
              setDraft(
                i18nKey === 'models'
                  ? { kind: 'provider', isNew: true, name: '', remark: '', website: '', baseUrl: '', apiFormat: 'anthropic', authHeader: '', key: '', primary: '', reasoning: '', fast: '', default: '', enableThinking: false, isDefault: false }
                  : { kind: 'skills', isNew: true, name: '', content: '' },
              )
            }
          >
            <Plus size={16} /> {t('common:actions.new')}
          </Button>
        }
      />

      {/* 列表 */}
      {query.isLoading ? (
        <EmptyState text={t('common:state.loading')} />
      ) : query.isError ? (
        <EmptyState text={t('common:state.error')} danger />
      ) : items.length === 0 ? (
        <EmptyState text={t('common:empty.noItems')} />
      ) : i18nKey === 'skills' ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 16,
          }}
        >
          {items.map((item) => {
            const s = item as Skill
            return (
              <article
                key={s.id}
                className="surface-panel asset-card"
                style={{
                  borderRadius: 18,
                  padding: 18,
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <h3 className="section-title">{s.name}</h3>
                  {s.description ? (
                    <p className="section-subtitle" style={{ marginTop: 4 }}>
                      {s.description}
                    </p>
                  ) : null}
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginTop: 14,
                    paddingTop: 10,
                    borderTop: '1px solid var(--color-border)',
                  }}
                >
                  <span style={{ fontSize: '0.72rem', color: 'var(--color-fg-3)' }}>{s.id}</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() =>
                        setDraft({ kind: 'skills', isNew: false, id: s.id, name: s.name, content: s.content })
                      }
                    >
                      <Pencil size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={async () => {
                        const ok = await confirmDialog({
                          title: t('common:confirm.delete'),
                          confirmText: t('common:actions.delete'),
                        })
                        if (!ok) return
                        void removeSkill.mutateAsync(s.id)
                      }}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      ) : (
        <section className="glass-panel" style={{ borderRadius: 20, overflow: 'hidden' }}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('common:columns.name')}</TableHead>
                <TableHead>{t('common:columns.meta')}</TableHead>
                <TableHead style={{ width: 100 }}>{t('common:columns.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const p = item as Provider
                return (
                  <TableRow key={item.id}>
                    <TableCell style={{ fontWeight: 500 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Switch
                          checked={p.isDefault ?? false}
                          onCheckedChange={(c) => {
                            if (!c) return // 互斥，不能取消只能切换
                            void saveProvider.mutateAsync({ ...p, isDefault: true })
                          }}
                        />
                        {item.name}
                        {p.isDefault ? (
                          <Badge variant="brand" style={{ fontSize: '0.7rem' }}>
                            {t('common:columns.active')}
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell style={{ color: 'var(--color-fg-2)' }}>
                      <ProviderMeta provider={p} />
                    </TableCell>
                    <TableCell>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() =>
                            setDraft({
                              kind: 'provider', isNew: false, id: p.id, name: p.name,
                              remark: p.remark ?? '', website: p.website ?? '', baseUrl: p.baseUrl ?? '',
                              apiFormat: p.apiFormat, authHeader: p.authHeader ?? '', key: '',
                              primary: p.models.primary ?? '', reasoning: p.models.reasoning ?? '',
                              fast: p.models.fast ?? '', default: p.models.default ?? '',
                              enableThinking: p.enableThinking ?? false,
                              isDefault: p.isDefault ?? false,
                            })
                          }
                        >
                          <Pencil size={14} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={async () => {
                            const ok = await confirmDialog({
                              title: t('common:confirm.delete'),
                              confirmText: t('common:actions.delete'),
                            })
                            if (!ok) return
                            if (p.keyId) void window.one.secrets.removeKey(p.keyId).then(unwrap).catch(() => {})
                            void removeProvider.mutateAsync(p.id)
                          }}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </section>
      )}

      {/* 编辑/新建抽屉 */}
      <Drawer open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <DrawerContent>
          {draft ? <DraftForm draft={draft} setDraft={setDraft} i18nKey={i18nKey} /> : null}
        </DrawerContent>
      </Drawer>
    </div>
  )
}

interface Draft {
  kind: 'skills' | 'provider'
  isNew: boolean
  id?: string
  name?: string
  content?: string
  // provider
  remark?: string
  website?: string
  baseUrl?: string
  apiFormat?: ApiFormat
  authHeader?: string
  key?: string
  primary?: string
  reasoning?: string
  fast?: string
  default?: string
  enableThinking?: boolean
  isDefault?: boolean
}

function DraftForm({
  draft,
  setDraft,
  i18nKey,
}: {
  draft: Draft
  setDraft: (d: Draft) => void
  i18nKey: 'skills' | 'models'
}) {
  const { t } = useTranslation(['common'])
  const saveSkill = useSaveSkill()
  const saveProvider = useSaveProvider()

  const save = async (): Promise<void> => {
    if (!draft.name?.trim()) return
    if (draft.kind === 'skills') {
      await saveSkill.mutateAsync({ id: draft.id, name: draft.name!, content: draft.content ?? '' })
    } else if (draft.kind === 'provider') {
      const provider = await saveProvider.mutateAsync({
        id: draft.id,
        name: draft.name!,
        remark: draft.remark || undefined,
        website: draft.website || undefined,
        baseUrl: draft.baseUrl || undefined,
        apiFormat: draft.apiFormat,
        authHeader: draft.authHeader || undefined,
        models: {
          primary: draft.primary || undefined,
          reasoning: draft.reasoning || undefined,
          fast: draft.fast || undefined,
          default: draft.default || undefined,
        },
        enableThinking: draft.enableThinking,
        isDefault: draft.isDefault,
      })
      if (provider.keyId && draft.key) {
        await window.one.secrets
          .setLLMConfig({ keyId: provider.keyId, apiKey: draft.key })
          .then(unwrap)
          .catch(() => {})
      }
    }
    // 关闭抽屉
    setDraft(null as never)
  }

  return (
    <>
      <DrawerTitle>{draft.isNew ? t('common:actions.new') : t('common:actions.edit')}</DrawerTitle>
      <div style={{ display: 'grid', gap: 14, marginTop: 20 }}>
        <Field label={t('common:columns.name')}>
          <Input value={draft.name ?? ''} onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus />
        </Field>

        {draft.kind === 'skills' ? (
          <Field label={t('common:columns.content')}>
            <textarea
              value={draft.content ?? ''}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
              style={{ ...textareaStyle, fontFamily: 'var(--font-mono)', minHeight: 160 }}
            />
          </Field>
        ) : null}

        {draft.kind === 'provider' ? (
          <>
            <Field label={t('common:columns.remark')}>
              <Input value={draft.remark ?? ''} onChange={(e) => setDraft({ ...draft, remark: e.target.value })} />
            </Field>
            <Field label={t('common:columns.website')}>
              <Input value={draft.website ?? ''} onChange={(e) => setDraft({ ...draft, website: e.target.value })} placeholder="https://" />
            </Field>
            <Field label={t('common:columns.baseUrl')}>
              <Input value={draft.baseUrl ?? ''} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} placeholder={t('common:columns.baseUrlPh')} />
            </Field>
            <Field label={t('common:columns.apiFormat')}>
              <select
                value={draft.apiFormat ?? ''}
                onChange={(e) => setDraft({ ...draft, apiFormat: e.target.value as ApiFormat })}
                style={selectStyle}
              >
                <option value="anthropic">anthropic</option>
                <option value="openai">openai</option>
                <option value="custom">custom</option>
              </select>
            </Field>
            <Field label={t('common:columns.authHeader')}>
              <select
                value={draft.authHeader ?? ''}
                onChange={(e) => setDraft({ ...draft, authHeader: e.target.value })}
                style={selectStyle}
              >
                <option value="">{t('common:columns.authAuto')}</option>
                <option value="authorization">{t('common:columns.authBearer')}</option>
                <option value="x-api-key">{t('common:columns.authApiKey')}</option>
              </select>
            </Field>
            <Field label={t('common:columns.apiKey')}>
              <Input
                type="password"
                value={draft.key ?? ''}
                onChange={(e) => setDraft({ ...draft, key: e.target.value })}
                placeholder={t('common:columns.apiKeyPh')}
              />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Field label={t('common:columns.primary')}>
                <Input value={draft.primary ?? ''} onChange={(e) => setDraft({ ...draft, primary: e.target.value })} placeholder="claude-sonnet-5" />
              </Field>
              <Field label={t('common:columns.reasoning')}>
                <Input value={draft.reasoning ?? ''} onChange={(e) => setDraft({ ...draft, reasoning: e.target.value })} placeholder="claude-opus-5" />
              </Field>
              <Field label={t('common:columns.fast')}>
                <Input value={draft.fast ?? ''} onChange={(e) => setDraft({ ...draft, fast: e.target.value })} placeholder="claude-haiku-4-5" />
              </Field>
              <Field label={t('common:columns.default')}>
                <Input value={draft.default ?? ''} onChange={(e) => setDraft({ ...draft, default: e.target.value })} placeholder="claude-sonnet-5" />
              </Field>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.875rem', color: 'var(--color-fg-2)' }}>
              <Switch
                checked={draft.enableThinking ?? false}
                onCheckedChange={(c) => setDraft({ ...draft, enableThinking: c })}
              />
              {t('common:columns.enableThinking')}
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.875rem', color: 'var(--color-fg-2)' }}>
              <Switch
                checked={draft.isDefault ?? false}
                onCheckedChange={(c) => setDraft({ ...draft, isDefault: c })}
              />
              {t('common:columns.default')}
            </label>
          </>
        ) : null}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={() => setDraft(null as never)}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            onClick={() => void save()}
            disabled={!draft.name?.trim() || (draft.kind === 'provider' && !draft.primary?.trim() && !draft.default?.trim())}
          >
            {t('common:actions.save')}
          </Button>
        </div>
      </div>
    </>
  )
}

const textareaStyle: React.CSSProperties = {
  minHeight: 120,
  borderRadius: 12,
  border: '1px solid var(--color-border)',
  background: 'var(--color-bg-1)',
  color: 'var(--color-fg-1)',
  padding: 10,
  fontFamily: 'inherit',
  fontSize: '0.875rem',
  resize: 'vertical',
  width: '100%',
}

const selectStyle: React.CSSProperties = {
  height: 36,
  borderRadius: 12,
  border: '1px solid var(--color-border)',
  background: 'var(--color-bg-1)',
  color: 'var(--color-fg-1)',
  padding: '0 10px',
  width: '100%',
}

function ProviderMeta({ provider }: { provider: Provider }) {
  const { t } = useTranslation(['common'])
  const parts: string[] = []
  if (provider.baseUrl) parts.push(provider.baseUrl)
  parts.push(provider.apiFormat)
  const ms = provider.models
  const modelParts: string[] = []
  if (ms.primary) modelParts.push(t('common:providers.primaryShort', { model: ms.primary }))
  if (ms.reasoning) modelParts.push(t('common:providers.reasoningShort', { model: ms.reasoning }))
  if (ms.fast) modelParts.push(t('common:providers.fastShort', { model: ms.fast }))
  if (modelParts.length) parts.push(modelParts.join(' '))
  return <span>{parts.join(' · ')}</span>
}
