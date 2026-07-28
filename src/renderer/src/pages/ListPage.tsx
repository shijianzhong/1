import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Pencil } from 'lucide-react'
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
import { Button } from '@renderer/components/ui/Button'
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
import { Input } from '@renderer/components/ui/Input'
import type { Agent, ModelConfig, Skill } from '@shared/types'

// —— 管理后台列表（§3 + §5.5）——
// 顶部工具条 + Table（行无分割线 hover 浮起）+ Drawer 编辑抽屉。
// 空态/加载态/错误态规范。

interface ListPageProps {
  i18nKey: 'agents' | 'skills' | 'models'
}

type Entity = Agent | Skill | ModelConfig

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

  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  const [draftName, setDraftName] = useState('')

  const items: Entity[] = query.data ?? []

  const onNew = (): void => {
    const name = window.prompt(t('common:prompt.name'))
    if (!name) return
    if (i18nKey === 'agents') void saveAgent.mutateAsync({ name, instructions: '', source: 'custom' })
    else if (i18nKey === 'skills') void saveSkill.mutateAsync({ name, content: '' })
    else if (i18nKey === 'models') void saveModel.mutateAsync({ name, modelId: name })
  }

  const onEdit = (item: Entity): void => {
    setEditing({ id: item.id, name: item.name })
    setDraftName(item.name)
  }

  const onSaveEdit = (): void => {
    if (!editing || !draftName.trim()) return
    const item = items.find((i) => i.id === editing.id)
    if (!item) return
    if (i18nKey === 'agents') void saveAgent.mutateAsync({ ...(item as Agent), name: draftName })
    else if (i18nKey === 'skills') void saveSkill.mutateAsync({ ...(item as Skill), name: draftName })
    else if (i18nKey === 'models') void saveModel.mutateAsync({ ...(item as ModelConfig), name: draftName })
    setEditing(null)
  }

  const onRemove = (id: string): void => {
    if (!window.confirm(t('common:confirm.delete'))) return
    if (i18nKey === 'agents') void removeAgent.mutateAsync(id)
    else if (i18nKey === 'skills') void removeSkill.mutateAsync(id)
    else if (i18nKey === 'models') void removeModel.mutateAsync(id)
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
                  <TableCell style={{ fontWeight: 500 }}>{item.name}</TableCell>
                  <TableCell style={{ color: 'var(--color-fg-2)' }}>
                    {(item as Agent & { description?: string }).description
                      ?? (item as ModelConfig).modelId
                      ?? ''}
                  </TableCell>
                  <TableCell>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <Button variant="ghost" size="icon" onClick={() => onEdit(item)}>
                        <Pencil size={14} />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => onRemove(item.id)}>
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

      {/* 编辑抽屉 */}
      <Drawer open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DrawerContent>
          <DrawerTitle>{t('common:actions.edit')}</DrawerTitle>
          <div style={{ display: 'grid', gap: 14, marginTop: 20 }}>
            <div>
              <label style={{ fontSize: '0.875rem', color: 'var(--color-fg-2)' }}>
                {t('common:columns.name')}
              </label>
              <Input value={draftName} onChange={(e) => setDraftName(e.target.value)} style={{ marginTop: 6 }} />
            </div>
            <Button onClick={onSaveEdit} disabled={!draftName.trim()}>
              {t('common:actions.save')}
            </Button>
          </div>
        </DrawerContent>
      </Drawer>
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
