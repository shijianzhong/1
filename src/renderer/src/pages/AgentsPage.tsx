import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Pencil, Bot, BookOpen } from 'lucide-react'
import {
  useAgents,
  useRemoveAgent,
  useSaveAgent,
  useSkills,
} from '@renderer/api/hooks'
import { RegistryPublishButton } from '@renderer/components/RegistryPublish'
import { Button } from '@renderer/components/ui/Button'
import { Input } from '@renderer/components/ui/Input'
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
} from '@renderer/components/ui/Drawer'
import { Badge } from '@renderer/components/ui/Badge'
import { confirmDialog } from '@renderer/components/ui/ConfirmDialog'
import type { Agent } from '@shared/types'

// —— 角色管理页（借鉴 Proton AgentsPage 范式）——
// 创建空白 Agent（角色身份），不含编排逻辑。
// 编排在 /capabilities 页面进行，Agent 节点通过 id 引用已创建的角色。

interface Draft {
  isNew: boolean
  id?: string
  name: string
  description: string
  instructions: string
  modelId: string
  temperature: string
  maxTokens: string
  outputConstraints: string
  skillIds: string[]
}

const EMPTY_DRAFT: Draft = {
  isNew: true,
  name: '',
  description: '',
  instructions: '',
  modelId: '',
  temperature: '',
  maxTokens: '',
  outputConstraints: '',
  skillIds: [],
}

export function AgentsPage() {
  const { t } = useTranslation(['common'])
  const { data, isLoading, isError } = useAgents()
  const skillsQ = useSkills()
  const saveAgent = useSaveAgent()
  const removeAgent = useRemoveAgent()
  const [draft, setDraft] = useState<Draft | null>(null)

  const agents: Agent[] = data ?? []
  const skills = skillsQ.data ?? []

  const openNew = (): void => setDraft({ ...EMPTY_DRAFT })
  const openEdit = (a: Agent): void =>
    setDraft({
      isNew: false,
      id: a.id,
      name: a.name,
      description: a.description ?? '',
      instructions: a.instructions,
      modelId: a.modelId ?? '',
      temperature: a.temperature?.toString() ?? '',
      maxTokens: a.maxTokens?.toString() ?? '',
      outputConstraints: a.outputConstraints ?? '',
      skillIds: a.skillIds ?? [],
    })

  const onSave = async (): Promise<void> => {
    if (!draft?.name.trim()) return
    await saveAgent.mutateAsync({
      id: draft.id,
      name: draft.name.trim(),
      description: draft.description.trim() || undefined,
      instructions: draft.instructions,
      modelId: draft.modelId.trim() || undefined,
      temperature: draft.temperature ? parseFloat(draft.temperature) : undefined,
      maxTokens: draft.maxTokens ? parseInt(draft.maxTokens) : undefined,
      outputConstraints: draft.outputConstraints.trim() || undefined,
      skillIds: draft.skillIds,
      source: 'custom',
    })
    setDraft(null)
  }

  const onRemove = async (id: string): Promise<void> => {
    const ok = await confirmDialog({
      title: t('common:confirm.delete'),
      confirmText: t('common:actions.delete'),
    })
    if (!ok) return
    await removeAgent.mutateAsync(id)
  }

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', display: 'grid', gap: 20 }}>
      {/* 顶部工具条 */}
      <section
        className="glass-panel"
        style={{
          padding: 16,
          borderRadius: 20,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <div>
          <h2 className="section-title" style={{ fontSize: '1rem' }}>
            {t('common:list.agents.title')}
          </h2>
          <p className="section-subtitle">{t('common:list.agents.description')}</p>
        </div>
        <Button onClick={openNew}>
          <Plus size={16} /> {t('common:actions.new')}
        </Button>
      </section>

      {/* 角色卡片网格 */}
      {isLoading ? (
        <EmptyState text={t('common:state.loading')} />
      ) : isError ? (
        <EmptyState text={t('common:state.error')} danger />
      ) : agents.length === 0 ? (
        <button
          type="button"
          onClick={openNew}
          className="glass-panel"
          style={{
            borderRadius: 20,
            padding: 48,
            textAlign: 'center',
            border: 0,
            cursor: 'pointer',
            color: 'var(--color-fg-2)',
            display: 'grid',
            gap: 8,
            justifyItems: 'center',
          }}
        >
          <Bot size={40} style={{ color: 'var(--color-brand-500)' }} />
          <p className="section-title">{t('common:empty.noItems')}</p>
          <p className="section-subtitle">{t('common:list.agents.description')}</p>
        </button>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 16,
          }}
        >
          {agents.map((a) => (
            <article
              key={a.id}
              className="surface-panel"
              style={{
                borderRadius: 18,
                padding: 18,
                transition: 'transform 120ms ease, box-shadow 120ms ease',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', minWidth: 0 }}>
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 10,
                      background: 'var(--color-bg-3)',
                      display: 'grid',
                      placeItems: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <Bot size={18} style={{ color: 'var(--color-brand-500)' }} />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <h3 className="section-title">{a.name}</h3>
                    {a.description ? (
                      <p className="section-subtitle" style={{ marginTop: 2 }}>
                        {a.description}
                      </p>
                    ) : null}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  <RegistryPublishButton kind="agent" localId={a.id} />
                  <Button variant="ghost" size="icon" onClick={() => openEdit(a)}>
                    <Pencil size={14} />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => void onRemove(a.id)}>
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
              {a.instructions ? (
                <p
                  style={{
                    margin: '10px 0 0',
                    fontSize: '0.8rem',
                    color: 'var(--color-fg-2)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {a.instructions.slice(0, 80)}
                  {a.instructions.length > 80 ? '…' : ''}
                </p>
              ) : null}
              <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                {a.modelId ? (
                  <Badge variant="brand" style={{ fontSize: '0.7rem' }}>
                    {a.modelId}
                  </Badge>
                ) : null}
                {(a.skillIds ?? []).map((sid) => {
                  const skill = skills.find((s) => s.id === sid)
                  return (
                    <Badge key={sid} variant="default" style={{ fontSize: '0.7rem' }}>
                      <BookOpen size={10} style={{ marginRight: 3 }} />
                      {skill?.name ?? sid}
                    </Badge>
                  )
                })}
                {a.source === 'custom' ? (
                  <Badge style={{ fontSize: '0.7rem' }}>{t('common:agents.custom')}</Badge>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}

      {/* 编辑/新建抽屉 */}
      <Drawer open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <DrawerContent>
          {draft ? (
            <>
              <DrawerTitle>
                {draft.isNew ? t('common:actions.new') : t('common:actions.edit')}
              </DrawerTitle>
              <div style={{ display: 'grid', gap: 14, marginTop: 20 }}>
                <Field label={t('common:columns.name')}>
                  <Input
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    autoFocus
                  />
                </Field>
                <Field label={t('common:columns.description')}>
                  <Input
                    value={draft.description}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                    placeholder={t('common:agents.descriptionPh')}
                  />
                </Field>
                <Field label={t('common:columns.instructions')}>
                  <textarea
                    value={draft.instructions}
                    onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
                    style={textareaStyle}
                    placeholder={t('common:agents.instructionsPh')}
                  />
                </Field>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <Field label={t('common:columns.modelId')}>
                    <Input
                      value={draft.modelId}
                      onChange={(e) => setDraft({ ...draft, modelId: e.target.value })}
                      placeholder={t('common:agents.modelIdPh')}
                    />
                  </Field>
                  <Field label="Temperature">
                    <Input
                      value={draft.temperature}
                      onChange={(e) => setDraft({ ...draft, temperature: e.target.value })}
                      placeholder="0.7"
                      type="number"
                      step="0.1"
                      min="0"
                      max="2"
                    />
                  </Field>
                </div>
                <Field label="Max Tokens">
                  <Input
                    value={draft.maxTokens}
                    onChange={(e) => setDraft({ ...draft, maxTokens: e.target.value })}
                    placeholder="16384"
                    type="number"
                    min="1024"
                  />
                </Field>
                <Field label={t('common:agents.outputConstraints')}>
                  <Input
                    value={draft.outputConstraints}
                    onChange={(e) => setDraft({ ...draft, outputConstraints: e.target.value })}
                    placeholder={t('common:agents.outputConstraintsPh')}
                  />
                </Field>
                <Field label={t('common:agents.skills')}>
                  {skills.length === 0 ? (
                    <p style={{ fontSize: '0.8rem', color: 'var(--color-fg-3)', margin: '4px 0 0' }}>
                      {t('common:agents.noSkills')}
                    </p>
                  ) : (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                      {skills.map((s) => {
                        const active = draft.skillIds.includes(s.id)
                        return (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() =>
                              setDraft((d) => {
                                if (!d) return d
                                return {
                                  ...d,
                                  skillIds: active
                                    ? d.skillIds.filter((id) => id !== s.id)
                                    : [...d.skillIds, s.id],
                                }
                              })
                            }
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 4,
                              padding: '4px 10px',
                              borderRadius: 999,
                              fontSize: '0.78rem',
                              cursor: 'pointer',
                              border: active
                                ? '1px solid var(--color-brand-500)'
                                : '1px solid var(--color-border)',
                              background: active
                                ? 'var(--color-brand-500-15, color-mix(in srgb, var(--color-brand-500) 15%, transparent))'
                                : 'var(--color-bg-2)',
                              color: active
                                ? 'var(--color-brand-500)'
                                : 'var(--color-fg-2)',
                              transition: 'all 120ms ease',
                            }}
                          >
                            <BookOpen size={11} />
                            {s.name}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </Field>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <Button variant="ghost" onClick={() => setDraft(null)}>
                    {t('common:actions.cancel')}
                  </Button>
                  <Button
                    onClick={() => void onSave()}
                    disabled={!draft.name.trim() || saveAgent.isPending}
                  >
                    {t('common:actions.save')}
                  </Button>
                </div>
              </div>
            </>
          ) : null}
        </DrawerContent>
      </Drawer>
    </div>
  )
}

const textareaStyle: React.CSSProperties = {
  minHeight: 140,
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
