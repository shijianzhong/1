import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Plus, Boxes, Trash2 } from 'lucide-react'
import {
  useCapabilities,
  useSaveCapability,
  useRemoveCapability,
} from '@renderer/api/hooks'
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
      <section
        className="glass-panel"
        style={{ padding: 16, borderRadius: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <div>
          <h2 className="section-title" style={{ fontSize: '1rem' }}>
            {t('editor:capabilities.title')}
          </h2>
          <p className="section-subtitle">{t('editor:capabilities.subtitle')}</p>
        </div>
        <Button onClick={openModal}>
          <Plus size={16} /> {t('editor:capabilities.new')}
        </Button>
      </section>

      {/* 状态态 */}
      {isLoading ? (
        <EmptyState text={t('common:state.loading')} />
      ) : isError ? (
        <EmptyState text={t('common:state.error')} danger />
      ) : caps.length === 0 ? (
        <button
          type="button"
          onClick={openModal}
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
          <Boxes size={40} style={{ color: 'var(--color-brand-500)' }} />
          <p className="section-title">{t('editor:capabilities.emptyTitle')}</p>
          <p className="section-subtitle">{t('editor:capabilities.emptyHint')}</p>
        </button>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            gap: 16,
          }}
        >
          {caps.map((cap) => (
            <article
              key={cap.id}
              className="surface-panel"
              onClick={() => nav(`/capability/${cap.id}`)}
              style={{
                borderRadius: 18,
                padding: 18,
                cursor: 'pointer',
                transition: 'transform 120ms ease, box-shadow 120ms ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'translateY(-2px)'
                e.currentTarget.style.boxShadow = 'var(--shadow-2)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'none'
                e.currentTarget.style.boxShadow = 'var(--shadow-1)'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <h3 className="section-title">{cap.name}</h3>
                  {cap.description ? (
                    <p className="section-subtitle" style={{ marginTop: 4 }}>
                      {cap.description}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={(e) => void onRemove(e, cap.id)}
                  style={{
                    border: 0,
                    background: 'transparent',
                    color: 'var(--color-fg-3)',
                    cursor: 'pointer',
                    padding: 4,
                    borderRadius: 8,
                  }}
                  aria-label="delete"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <p style={{ margin: '12px 0 0', fontSize: '0.75rem', color: 'var(--color-fg-3)' }}>
                {cap.id}
              </p>
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

// 触发 unwrap 类型推导（未来 edit 用）
void unwrap
