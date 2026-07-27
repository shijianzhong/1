import { useTranslation } from 'react-i18next'
import {
  useAgents,
  useModels,
  useRemoveAgent,
  useRemoveModel,
  useRemoveSkill,
  useSaveAgent,
  useSaveModel,
  useSaveSkill,
  useSkills,
} from '@renderer/api/hooks'

interface ListPageProps {
  /** i18n key 前缀 + 数据源选择 */
  i18nKey: 'agents' | 'skills' | 'models' | 'tasks'
}

type ListItem = { id: string; name: string; description?: string }

export function ListPage({ i18nKey }: ListPageProps) {
  const { t } = useTranslation(['common'])
  const title = t(`common:list.${i18nKey}.title`)
  const description = t(`common:list.${i18nKey}.description`)

  // tasks 路由暂未接 hooks（阶段3任务历史），用空态占位
  if (i18nKey === 'tasks') {
    return (
      <ListShell title={title} description={description} onNew={() => {}}>
        <EmptyState text={t('common:empty.comingSoon')} />
      </ListShell>
    )
  }

  return <DataList i18nKey={i18nKey} title={title} description={description} />
}

function DataList({
  i18nKey,
  title,
  description,
}: {
  i18nKey: 'agents' | 'skills' | 'models'
  title: string
  description: string
}) {
  const { t } = useTranslation(['common'])

  // 按 i18nKey 选 hook（React 规则：hooks 必须无条件调用，故全部取出再选）
  const agentsQ = useAgents()
  const skillsQ = useSkills()
  const modelsQ = useModels()

  const saveAgent = useSaveAgent()
  const saveSkill = useSaveSkill()
  const saveModel = useSaveModel()
  const removeAgent = useRemoveAgent()
  const removeSkill = useRemoveSkill()
  const removeModel = useRemoveModel()

  const query =
    i18nKey === 'agents' ? agentsQ : i18nKey === 'skills' ? skillsQ : modelsQ
  const items: ListItem[] = (query.data ?? []).map((it) => ({
    id: it.id,
    name: it.name,
    description:
      'description' in it
        ? (it as { description?: string }).description
        : (it as { modelId: string }).modelId,
  }))

  const onNew = (): void => {
    const name = window.prompt(t('common:prompt.name'))
    if (!name) return
    if (i18nKey === 'agents') {
      void saveAgent.mutateAsync({ name, instructions: '', source: 'custom' })
    } else if (i18nKey === 'skills') {
      void saveSkill.mutateAsync({ name, content: '' })
    } else if (i18nKey === 'models') {
      void saveModel.mutateAsync({ name, modelId: name })
    }
  }

  const onRemove = (id: string): void => {
    if (!window.confirm(t('common:confirm.delete'))) return
    if (i18nKey === 'agents') void removeAgent.mutateAsync(id)
    else if (i18nKey === 'skills') void removeSkill.mutateAsync(id)
    else if (i18nKey === 'models') void removeModel.mutateAsync(id)
  }

  return (
    <ListShell title={title} description={description} onNew={onNew}>
      {query.isLoading ? (
        <EmptyState text={t('common:state.loading')} />
      ) : query.isError ? (
        <EmptyState text={t('common:state.error')} />
      ) : items.length === 0 ? (
        <EmptyState text={t('common:empty.noItems')} />
      ) : (
        <section className="placeholder-grid">
          {items.map((item) => (
            <article
              key={item.id}
              className="surface-panel placeholder-card"
              style={{ borderRadius: 20 }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <h3 className="section-title">{item.name}</h3>
                  {item.description ? (
                    <p className="section-subtitle">{item.description}</p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => onRemove(item.id)}
                  style={{
                    border: 0,
                    borderRadius: 999,
                    background: 'var(--color-bg-3)',
                    color: 'var(--color-fg-2)',
                    padding: '6px 12px',
                    cursor: 'pointer',
                    fontSize: '0.75rem',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('common:actions.delete')}
                </button>
              </div>
            </article>
          ))}
        </section>
      )}
    </ListShell>
  )
}

function ListShell({
  title,
  description,
  onNew,
  children,
}: {
  title: string
  description: string
  onNew: () => void
  children: React.ReactNode
}) {
  const { t } = useTranslation(['common'])
  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <section
        className="glass-panel"
        style={{
          padding: 16,
          borderRadius: 24,
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <h2 className="section-title" style={{ fontSize: '1rem' }}>
            {title}
          </h2>
          <p className="section-subtitle">{description}</p>
        </div>
        <button
          type="button"
          onClick={onNew}
          style={{
            border: 0,
            borderRadius: 999,
            background: 'var(--color-brand-500)',
            color: 'white',
            padding: '10px 16px',
            cursor: 'pointer',
          }}
        >
          {t('common:actions.new')}
        </button>
      </section>
      {children}
    </div>
  )
}

function EmptyState({ text }: { text: string }): React.ReactNode {
  return (
    <div
      className="glass-panel"
      style={{
        borderRadius: 20,
        padding: 40,
        textAlign: 'center',
        color: 'var(--color-fg-2)',
      }}
    >
      {text}
    </div>
  )
}
