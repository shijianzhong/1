import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Pencil, Upload, Wrench, FileCode2 } from 'lucide-react'
import {
  useSkills,
  useRemoveSkill,
  useSaveSkill,
  usePickSkillFile,
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
import { EmptyState } from '@renderer/components/ui/EmptyState'
import { Field } from '@renderer/components/ui/Field'
import { PageToolbar } from '@renderer/components/ui/PageToolbar'
import type { Skill } from '@shared/types'

// —— 技能管理页 ——
// 支持两种创建方式：
//   1. 新建：手动填写 name + content
//   2. 上传：选择 .zip 技能包，自动解析 SKILL.md frontmatter 后落盘
// 编排页面通过 skill id 引用已创建的技能。
// 卡片描述限 2 行；抽屉用 flex 布局撑满高度，描述和内容输入框尽量高。

interface Draft {
  isNew: boolean
  id?: string
  name: string
  description: string
  content: string
  scriptPath?: string
}

const EMPTY_DRAFT: Draft = {
  isNew: true,
  name: '',
  description: '',
  content: '',
}

export function SkillsPage() {
  const { t } = useTranslation(['common'])
  const { data, isLoading, isError } = useSkills()
  const saveSkill = useSaveSkill()
  const removeSkill = useRemoveSkill()
  const pickFile = usePickSkillFile()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const skills: Skill[] = data ?? []

  const openNew = (): void => setDraft({ ...EMPTY_DRAFT })
  const openEdit = (s: Skill): void =>
    setDraft({
      isNew: false,
      id: s.id,
      name: s.name,
      description: s.description ?? '',
      content: s.content,
      scriptPath: s.scriptPath,
    })

  const onSave = async (): Promise<void> => {
    if (!draft?.name.trim()) return
    await saveSkill.mutateAsync({
      id: draft.id,
      name: draft.name.trim(),
      description: draft.description.trim() || undefined,
      content: draft.content,
      scriptPath: draft.scriptPath,
    })
    setDraft(null)
  }

  const onRemove = async (id: string): Promise<void> => {
    const ok = await confirmDialog({
      title: t('common:confirm.delete'),
      confirmText: t('common:actions.delete'),
    })
    if (!ok) return
    await removeSkill.mutateAsync(id)
  }

  /** 上传技能文件 → 解析 → 自动保存 */
  const onUpload = async (): Promise<void> => {
    setUploading(true)
    setUploadError(null)
    try {
      const parsed = await pickFile.mutateAsync()
      if (!parsed) {
        // 用户取消选择
        setUploading(false)
        return
      }
      // 自动落盘
      await saveSkill.mutateAsync({
        name: parsed.name,
        description: parsed.description || undefined,
        content: parsed.content,
        discipline: parsed.discipline,
        scriptPath: parsed.scriptPath,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setUploadError(t('common:skills.uploadFailed', { message: msg }))
    } finally {
      setUploading(false)
    }
  }

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', display: 'grid', gap: 20 }}>
      {/* 顶部工具条 */}
      <PageToolbar
        title={t('common:list.skills.title')}
        subtitle={t('common:list.skills.description')}
        actions={
          <>
            <Button variant="outline" onClick={() => void onUpload()} disabled={uploading}>
              <Upload size={16} /> {uploading ? t('common:skills.uploading') : t('common:skills.upload')}
            </Button>
            {uploadError ? (
              <p role="alert" style={{ alignSelf: 'center', margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-danger)' }}>
                {uploadError}
              </p>
            ) : null}
            <Button onClick={openNew}>
              <Plus size={16} /> {t('common:actions.new')}
            </Button>
          </>
        }
      />

      {/* 技能卡片网格 */}
      {isLoading ? (
        <EmptyState text={t('common:state.loading')} />
      ) : isError ? (
        <EmptyState text={t('common:state.error')} danger />
      ) : skills.length === 0 ? (
        <EmptyState
          icon={Wrench}
          title={t('common:empty.noItems')}
          hint={t('common:list.skills.description')}
          onClick={openNew}
          actionLabel={t('common:actions.new')}
        />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 16,
          }}
        >
          {skills.map((s) => (
            <article
              key={s.id}
              className="surface-panel asset-card"
              style={{
                borderRadius: 18,
                padding: 18,
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
                  <Wrench size={18} style={{ color: 'var(--color-brand-500)' }} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <h3 className="section-title">{s.name}</h3>
                  {s.description ? (
                    <p
                      className="section-subtitle"
                      style={{
                        marginTop: 2,
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {s.description}
                    </p>
                  ) : null}
                </div>
              </div>
              {s.content ? (
                <p
                  style={{
                    margin: '10px 0 0',
                    fontSize: '0.8rem',
                    color: 'var(--color-fg-2)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {s.content.slice(0, 80)}
                  {s.content.length > 80 ? '…' : ''}
                </p>
              ) : null}
              <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                {s.scriptPath ? (
                  <Badge variant="brand" style={{ fontSize: '0.7rem' }}>
                    <FileCode2 size={10} style={{ marginRight: 4 }} />
                    {t('common:skills.hasScript')}
                  </Badge>
                ) : null}
                <Badge style={{ fontSize: '0.7rem' }}>
                  {t('common:skills.sizeK', { count: Math.ceil(s.content.length / 1000) })}
                </Badge>
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  gap: 4,
                  marginTop: 14,
                  paddingTop: 10,
                  borderTop: '1px solid var(--color-border)',
                }}
              >
                <RegistryPublishButton kind="skill" localId={s.id} />
                <Button variant="ghost" size="icon" onClick={() => openEdit(s)}>
                  <Pencil size={14} />
                </Button>
                <Button variant="ghost" size="icon" onClick={() => void onRemove(s.id)}>
                  <Trash2 size={14} />
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}

      {/* 编辑/新建抽屉 */}
      <Drawer open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <DrawerContent width={720}>
          {draft ? (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
              <DrawerTitle>
                {draft.isNew ? t('common:actions.new') : t('common:actions.edit')}
              </DrawerTitle>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 20, flex: 1, minHeight: 0 }}>
                <Field label={t('common:columns.name')}>
                  <Input
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    autoFocus
                  />
                </Field>
                <Field label={t('common:columns.description')}>
                  <textarea
                    value={draft.description}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                    style={descTextareaStyle}
                    placeholder={t('common:skills.descriptionPh')}
                    rows={5}
                  />
                </Field>
                <Field label={t('common:columns.content')} style={{ flex: '1', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                  <textarea
                    value={draft.content}
                    onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                    style={{ ...contentTextareaStyle, flex: 1, minHeight: 0 }}
                    placeholder={t('common:skills.contentPh')}
                  />
                </Field>
                {draft.scriptPath ? (
                  <p style={{ fontSize: '0.75rem', color: 'var(--color-fg-3)', flexShrink: 0 }}>
                    {t('common:skills.scriptPath', { path: draft.scriptPath })}
                  </p>
                ) : null}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexShrink: 0 }}>
                  <Button variant="ghost" onClick={() => setDraft(null)}>
                    {t('common:actions.cancel')}
                  </Button>
                  <Button
                    onClick={() => void onSave()}
                    disabled={!draft.name.trim() || saveSkill.isPending}
                  >
                    {t('common:actions.save')}
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

const descTextareaStyle: React.CSSProperties = {
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

const contentTextareaStyle: React.CSSProperties = {
  minHeight: 200,
  borderRadius: 12,
  border: '1px solid var(--color-border)',
  background: 'var(--color-bg-1)',
  color: 'var(--color-fg-1)',
  padding: 10,
  fontFamily: 'var(--font-mono)',
  fontSize: '0.875rem',
  resize: 'none',
  width: '100%',
}
