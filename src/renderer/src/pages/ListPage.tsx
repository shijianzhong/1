import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Pencil } from 'lucide-react'
import {
  useAgents,
  useModels,
  useProviders,
  useRemoveAgent,
  useRemoveModel,
  useRemoveSkill,
  useSaveAgent,
  useSaveModel,
  useSaveProvider,
  useSaveSkill,
  useSkills,
} from '@renderer/api/hooks'
import { unwrap } from '@renderer/api/client'
import { Button } from '@renderer/components/ui/Button'
import { Input } from '@renderer/components/ui/Input'
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
import type { Agent, ModelConfig, Provider, Skill } from '@shared/types'

// —— 管理后台列表（§3 + §5.5）——
// 顶部工具条 + Table + Drawer 编辑抽屉（按实体类型给对应表单字段）。
// 不再用 window.prompt（Electron 沙箱下不可靠），改用 Drawer 表单。

interface ListPageProps {
  i18nKey: 'agents' | 'skills' | 'models'
}

type Entity = Agent | Skill | ModelConfig

interface Draft {
  id?: string // 有 id=编辑，无=新建
  name: string
  // agent
  instructions: string
  // model
  modelId: string
  providerId: string // 关联 provider（key+baseUrl 共享）；空=新建独立 provider
  newProviderName: string // 新建 provider 名
  newProviderBaseUrl: string // 新建 provider baseUrl
  baseUrl: string // 模型自带（旧/独立）
  key: string
  tags: string // 逗号分隔
  isDefault: boolean
  // skill
  content: string
}

const EMPTY_DRAFT: Draft = {
  name: '',
  instructions: '',
  modelId: '',
  providerId: '',
  newProviderName: '',
  newProviderBaseUrl: '',
  baseUrl: '',
  key: '',
  tags: '',
  isDefault: false,
  content: '',
}

export function ListPage({ i18nKey }: ListPageProps) {
  const { t } = useTranslation(['common'])
  const title = t(`common:list.${i18nKey}.title`)
  const description = t(`common:list.${i18nKey}.description`)

  const agentsQ = useAgents()
  const skillsQ = useSkills()
  const modelsQ = useModels()
  const query = i18nKey === 'agents' ? agentsQ : i18nKey === 'skills' ? skillsQ : modelsQ

  const saveAgent = useSaveAgent()
  const saveSkill = useSaveSkill()
  const saveModel = useSaveModel()
  const removeAgent = useRemoveAgent()
  const removeSkill = useRemoveSkill()
  const removeModel = useRemoveModel()
  const providersQ = useProviders()
  const saveProvider = useSaveProvider()

  const [draft, setDraft] = useState<Draft | null>(null)
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean>>({})
  const items: Entity[] = query.data ?? []

  // 模型 key 状态
  if (i18nKey === 'models') {
    for (const m of items as ModelConfig[]) {
      if (m.keyId && keyStatus[m.id] === undefined) {
        void window.one.secrets
          .getLLMConfig(m.keyId)
          .then((r) => {
            if ('data' in r) setKeyStatus((s) => ({ ...s, [m.id]: r.data.hasKey }))
          })
          .catch(() => {})
      }
    }
  }

  const onNew = (): void => setDraft({ ...EMPTY_DRAFT, isDefault: items.length === 0 })

  const onEdit = (item: Entity): void => {
    if (i18nKey === 'agents') {
      const a = item as Agent
      setDraft({
        ...EMPTY_DRAFT,
        id: a.id,
        name: a.name,
        instructions: a.instructions,
      })
    } else if (i18nKey === 'skills') {
      const s = item as Skill
      setDraft({
        ...EMPTY_DRAFT,
        id: s.id,
        name: s.name,
        content: s.content,
      })
    } else {
      const m = item as ModelConfig
      setDraft({
        ...EMPTY_DRAFT,
        id: m.id,
        name: m.name,
        modelId: m.modelId,
        providerId: m.providerId ?? '',
        baseUrl: m.baseUrl ?? '',
        tags: (m.tags ?? []).join(', '),
        isDefault: m.isDefault ?? false,
      })
    }
  }

  const onSave = async (): Promise<void> => {
    if (!draft || !draft.name.trim()) return
    if (i18nKey === 'agents') {
      const existing = draft.id ? (items as Agent[]).find((a) => a.id === draft.id) : undefined
      await saveAgent.mutateAsync({
        id: draft.id,
        name: draft.name,
        instructions: draft.instructions || existing?.instructions || '',
        source: 'custom',
      })
    } else if (i18nKey === 'skills') {
      const existing = draft.id ? (items as Skill[]).find((s) => s.id === draft.id) : undefined
      await saveSkill.mutateAsync({
        id: draft.id,
        name: draft.name,
        content: draft.content || existing?.content || '',
      })
    } else {
      // 模型：先处理 provider（选已有 / 新建），再保存模型挂 providerId + tags
      let providerId = draft.providerId
      let keyForVault: string | undefined
      if (draft.providerId === '__new__' && draft.newProviderName.trim()) {
        // 新建 provider
        const provider = await saveProvider.mutateAsync({
          name: draft.newProviderName.trim(),
          baseUrl: draft.newProviderBaseUrl.trim() || undefined,
        })
        providerId = provider.id
        keyForVault = draft.key || undefined
      } else if (draft.providerId) {
        // 已有 provider：若填了 key 则更新 provider 的 key
        keyForVault = draft.key || undefined
      } else {
        // 无 provider（旧式独立模型）：key 用模型自带 keyId
        keyForVault = draft.key || undefined
      }
      const tags = draft.tags
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const saved = await saveModel.mutateAsync({
        id: draft.id,
        name: draft.name,
        modelId: draft.modelId,
        providerId: providerId || undefined,
        baseUrl: draft.baseUrl || undefined,
        isDefault: draft.isDefault,
        tags: tags.length ? tags : undefined,
      })
      // key 存 vault：挂 provider 的用 provider.keyId，独立的用 saved.keyId
      const keyId = providerId
        ? (await window.one.providers.list().then(unwrap).then(
            (ps) => ps.find((p) => p.id === providerId)?.keyId,
          )) ?? saved.keyId
        : saved.keyId
      if (keyId && keyForVault) {
        await window.one.secrets
          .setLLMConfig({ keyId, apiKey: keyForVault })
          .then(unwrap)
          .catch(() => {})
        setKeyStatus((s) => ({ ...s, [saved.id]: true }))
      }
    }
    setDraft(null)
  }

  const onRemove = async (id: string): Promise<void> => {
    if (!window.confirm(t('common:confirm.delete'))) return
    if (i18nKey === 'agents') await removeAgent.mutateAsync(id)
    else if (i18nKey === 'skills') await removeSkill.mutateAsync(id)
    else {
      const m = (items as ModelConfig[]).find((x) => x.id === id)
      if (m?.keyId) await window.one.secrets.removeKey(m.keyId).then(unwrap).catch(() => {})
      await removeModel.mutateAsync(id)
    }
  }

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', display: 'grid', gap: 20 }}>
      {/* 顶部工具条 */}
      <section
        className="glass-panel"
        style={{ padding: 16, borderRadius: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <div>
          <h2 className="section-title" style={{ fontSize: '1rem' }}>{title}</h2>
          <p className="section-subtitle">{description}</p>
        </div>
        <Button onClick={onNew}>
          <Plus size={16} /> {t('common:actions.new')}
        </Button>
      </section>

      {/* Table / 状态态 */}
      {query.isLoading ? (
        <EmptyState text={t('common:state.loading')} />
      ) : query.isError ? (
        <EmptyState text={t('common:state.error')} danger />
      ) : items.length === 0 ? (
        <EmptyState text={t('common:empty.noItems')} />
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
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell style={{ fontWeight: 500 }}>
                    {item.name}
                    {i18nKey === 'models' && (item as ModelConfig).isDefault ? (
                      <Badge variant="brand" style={{ marginLeft: 8, fontSize: '0.7rem' }}>
                        {t('common:columns.default')}
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell style={{ color: 'var(--color-fg-2)' }}>
                    {i18nKey === 'agents'
                      ? (item as Agent).description ?? ''
                      : i18nKey === 'skills'
                        ? (item as Skill).description ?? ''
                        : <ModelMeta model={item as ModelConfig} providers={providersQ.data ?? []} />}
                  </TableCell>
                  <TableCell>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <Button variant="ghost" size="icon" onClick={() => onEdit(item)}>
                        <Pencil size={14} />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => void onRemove(item.id)}>
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}

      {/* 编辑/新建抽屉 */}
      <Drawer open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <DrawerContent>
          <DrawerTitle>{draft?.id ? t('common:actions.edit') : t('common:actions.new')}</DrawerTitle>
          {draft ? (
            <div style={{ display: 'grid', gap: 14, marginTop: 20 }}>
              <Field label={t('common:columns.name')}>
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus />
              </Field>

              {i18nKey === 'agents' ? (
                <Field label={t('common:columns.instructions')}>
                  <textarea
                    value={draft.instructions}
                    onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
                    style={{
                      minHeight: 120,
                      borderRadius: 12,
                      border: '1px solid var(--color-border)',
                      background: 'var(--color-bg-1)',
                      color: 'var(--color-fg-1)',
                      padding: 10,
                      fontFamily: 'inherit',
                      fontSize: '0.875rem',
                      resize: 'vertical',
                    }}
                  />
                </Field>
              ) : null}

              {i18nKey === 'skills' ? (
                <Field label={t('common:columns.content')}>
                  <textarea
                    value={draft.content}
                    onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                    style={{
                      minHeight: 160,
                      borderRadius: 12,
                      border: '1px solid var(--color-border)',
                      background: 'var(--color-bg-1)',
                      color: 'var(--color-fg-1)',
                      padding: 10,
                      fontFamily: 'var(--font-mono, monospace)',
                      fontSize: '0.8rem',
                      resize: 'vertical',
                    }}
                  />
                </Field>
              ) : null}

              {i18nKey === 'models' ? (
                <>
                  <Field label={t('common:columns.modelId')}>
                    <Input
                      value={draft.modelId}
                      onChange={(e) => setDraft({ ...draft, modelId: e.target.value })}
                      placeholder="claude-sonnet-5"
                    />
                  </Field>
                  <Field label={t('common:columns.provider')}>
                    <select
                      value={draft.providerId}
                      onChange={(e) => setDraft({ ...draft, providerId: e.target.value })}
                      style={{
                        height: 36, borderRadius: 12, border: '1px solid var(--color-border)',
                        background: 'var(--color-bg-1)', color: 'var(--color-fg-1)', padding: '0 10px', width: '100%',
                      }}
                    >
                      <option value="">{t('common:columns.noProvider')}</option>
                      <option value="__new__">+ {t('common:columns.newProvider')}</option>
                      {(providersQ.data ?? []).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}{p.baseUrl ? ` · ${p.baseUrl}` : ''}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {draft.providerId === '__new__' ? (
                    <>
                      <Field label={t('common:columns.providerName')}>
                        <Input
                          value={draft.newProviderName}
                          onChange={(e) => setDraft({ ...draft, newProviderName: e.target.value })}
                          placeholder="Anthropic / 中转 A"
                        />
                      </Field>
                      <Field label={t('common:columns.baseUrl')}>
                        <Input
                          value={draft.newProviderBaseUrl}
                          onChange={(e) => setDraft({ ...draft, newProviderBaseUrl: e.target.value })}
                          placeholder={t('common:columns.baseUrlPh')}
                        />
                      </Field>
                      <Field label={t('common:columns.apiKey')}>
                        <Input
                          type="password"
                          value={draft.key}
                          onChange={(e) => setDraft({ ...draft, key: e.target.value })}
                          placeholder={t('common:columns.apiKeyPh')}
                        />
                      </Field>
                    </>
                  ) : draft.providerId ? (
                    <Field label={t('common:columns.apiKey')}>
                      <Input
                        type="password"
                        value={draft.key}
                        onChange={(e) => setDraft({ ...draft, key: e.target.value })}
                        placeholder={
                          keyStatusForProvider(draft.providerId, providersQ.data ?? [])
                            ? '••••••••（已配置，留空不改）'
                            : t('common:columns.apiKeyPh')
                        }
                      />
                    </Field>
                  ) : (
                    // 无 provider（旧式独立模型）
                    <>
                      <Field label={t('common:columns.baseUrl')}>
                        <Input
                          value={draft.baseUrl}
                          onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                          placeholder={t('common:columns.baseUrlPh')}
                        />
                      </Field>
                      <Field label={t('common:columns.apiKey')}>
                        <Input
                          type="password"
                          value={draft.key}
                          onChange={(e) => setDraft({ ...draft, key: e.target.value })}
                          placeholder={
                            draft.id && keyStatus[draft.id]
                              ? '••••••••（已配置，留空不改）'
                              : t('common:columns.apiKeyPh')
                          }
                        />
                      </Field>
                    </>
                  )}
                  <Field label={t('common:columns.tags')}>
                    <Input
                      value={draft.tags}
                      onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
                      placeholder={t('common:columns.tagsPh')}
                    />
                  </Field>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.875rem', color: 'var(--color-fg-2)' }}>
                    <input
                      type="checkbox"
                      checked={draft.isDefault}
                      onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })}
                    />
                    {t('common:columns.default')}
                  </label>
                </>
              ) : null}

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Button variant="ghost" onClick={() => setDraft(null)}>
                  {t('common:actions.cancel')}
                </Button>
                <Button
                  onClick={() => void onSave()}
                  disabled={!draft.name.trim() || (i18nKey === 'models' && !draft.modelId.trim())}
                >
                  {t('common:actions.save')}
                </Button>
              </div>
            </div>
          ) : null}
        </DrawerContent>
      </Drawer>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ fontSize: '0.875rem', color: 'var(--color-fg-2)' }}>{label}</label>
      <div style={{ marginTop: 6 }}>{children}</div>
    </div>
  )
}

function EmptyState({ text, danger }: { text: string; danger?: boolean }): React.ReactNode {
  return (
    <div
      className="glass-panel"
      style={{
        borderRadius: 20,
        padding: 40,
        textAlign: 'center',
        color: danger ? 'var(--color-danger)' : 'var(--color-fg-2)',
      }}
    >
      {text}
    </div>
  )
}

/** 查 provider 是否已配 key（getLLMConfig 查 provider.keyId） */
function keyStatusForProvider(providerId: string, providers: Provider[]): boolean {
  // 渲染层不缓存 provider key 状态，简化：假设有 keyId 即未配
  return false
}

/** 模型行 meta：modelId + provider + tags */
function ModelMeta({ model, providers }: { model: ModelConfig; providers: Provider[] }) {
  const provider = model.providerId ? providers.find((p) => p.id === model.providerId) : null
  const parts: string[] = [model.modelId]
  if (provider) parts.push(provider.name)
  else if (model.baseUrl) parts.push(model.baseUrl)
  if (model.tags?.length) parts.push(model.tags.join('/'))
  return <span>{parts.join(' · ')}</span>
}
