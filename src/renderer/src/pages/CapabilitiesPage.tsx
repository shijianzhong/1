import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Plus, Boxes, Trash2 } from 'lucide-react'
import {
  useCapabilities,
  useSaveCapability,
  useRemoveCapability,
} from '@renderer/api/hooks'
import { RegistryPublishButton } from '@renderer/components/RegistryPublish'
import { unwrap } from '@renderer/api/client'
import { Button } from '@renderer/components/ui/Button'
import { Input } from '@renderer/components/ui/Input'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogClose,
} from '@renderer/components/ui/Dialog'
import { confirmDialog } from '@renderer/components/ui/ConfirmDialog'
import { EmptyState } from '@renderer/components/ui/EmptyState'
import { PageToolbar } from '@renderer/components/ui/PageToolbar'
import type { Capability } from '@shared/types'

// —— 能力列表（§3 + EClaw CapabilitiesPage 范式）——
// 卡片网格，点卡片进画布 /capability/:id；新建弹窗填名后跳画布。
// 这是画布编辑器的入口，不是直接进画布。

export function CapabilitiesPage() {
  const { t } = useTranslation(['common', 'editor'])
  const nav = useNavigate()
  const { data, isLoading, isError } = useCapabilities()
  const saveCap = useSaveCapability()
  const removeCap = useRemoveCapability()
  const [showModal, setShowModal] = useState(false)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')

  const caps: Capability[] = data ?? []

  const openModal = (): void => {
    setName('')
    setDesc('')
    setShowModal(true)
  }

  const handleCreate = async (): Promise<void> => {
    if (!name.trim()) return
    try {
      const cap = await saveCap.mutateAsync({
        name: name.trim(),
        description: desc.trim() || undefined,
        graph: { nodes: [], edges: [] },
      })
      setShowModal(false)
      nav(`/capability/${cap.id}`)
    } catch {
      // TanStack Query onError 兜底
    }
  }

  const onRemove = async (e: React.MouseEvent, id: string): Promise<void> => {
    e.stopPropagation()
    const ok = await confirmDialog({
      title: t('common:confirm.delete'),
      confirmText: t('common:actions.delete'),
    })
    if (!ok) return
    await removeCap.mutateAsync(id)
  }

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', display: 'grid', gap: 20 }}>
      {/* page-head */}
      <PageToolbar
        title={t('editor:capabilities.title')}
        subtitle={t('editor:capabilities.subtitle')}
        actions={<Button onClick={openModal}><Plus size={16} /> {t('editor:capabilities.new')}</Button>}
      />

      {/* 状态态 */}
      {isLoading ? (
        <EmptyState text={t('common:state.loading')} />
      ) : isError ? (
        <EmptyState text={t('common:state.error')} danger />
      ) : caps.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title={t('editor:capabilities.emptyTitle')}
          hint={t('editor:capabilities.emptyHint')}
          onClick={openModal}
        />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 16,
          }}
        >
          {caps.map((cap) => (
            <article
              key={cap.id}
              className="surface-panel asset-card"
              onClick={() => nav(`/capability/${cap.id}`)}
              style={{
                borderRadius: 18,
                padding: 18,
                cursor: 'pointer',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <h3 className="section-title">{cap.name}</h3>
                {cap.description ? (
                  <p className="section-subtitle" style={{ marginTop: 4 }}>
                    {cap.description}
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
                <span style={{ fontSize: '0.72rem', color: 'var(--color-fg-3)' }}>{cap.id}</span>
                <span style={{ display: 'flex', gap: 2, alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
                  <RegistryPublishButton kind="capability" localId={cap.id} />
                  <Button variant="ghost" size="icon" onClick={(e) => void onRemove(e, cap.id)}>
                    <Trash2 size={14} />
                  </Button>
                </span>
              </div>
            </article>
          ))}
        </div>
      )}

      {/* 新建弹窗 */}
      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent style={{ maxWidth: 440 }}>
          <DialogTitle>{t('editor:capabilities.newTitle')}</DialogTitle>
          <div style={{ display: 'grid', gap: 14, marginTop: 16 }}>
            <div>
              <label style={{ fontSize: '0.875rem', color: 'var(--color-fg-2)' }}>
                {t('common:columns.name')}
              </label>
              <Input value={name} onChange={(e) => setName(e.target.value)} style={{ marginTop: 6 }} autoFocus />
            </div>
            <div>
              <label style={{ fontSize: '0.875rem', color: 'var(--color-fg-2)' }}>
                {t('editor:capabilities.desc')}
              </label>
              <Input value={desc} onChange={(e) => setDesc(e.target.value)} style={{ marginTop: 6 }} />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <DialogClose asChild>
                <Button variant="ghost">{t('common:actions.cancel')}</Button>
              </DialogClose>
              <Button onClick={() => void handleCreate()} disabled={!name.trim() || saveCap.isPending}>
                {t('common:actions.create')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// 触发 unwrap 类型推导（未来 edit 用）
void unwrap
