import { lazy, Suspense, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { unwrap } from '@renderer/api/client'
import type { CreateDraft } from '@shared/types'

// @xyflow/react 约 360KB：图预览按需加载，确认卡其余交互不受影响
const GraphPreview = lazy(() =>
  import('@renderer/components/GraphPreview').then((m) => ({ default: m.GraphPreview })),
)

// —— 创建确认卡（聊天创建闭环的前端落点）——
// 主 Agent 调 propose_* → 后端 emit proposal → 此卡渲染草稿（字段可编辑）。
// 用户点「确认入库」→ home:confirmCreate（以编辑后 payload 落库）→ 卡片定「已入库」；
// 点「取消」→ home:cancelCreate（丢弃草稿）→ 卡片定「已取消」。

export type CardStatus = 'pending' | 'saved' | 'cancelled'

/** 确认入库后要失效的 React Query 缓存（否则管理页/设置页显示旧数据） */
const INVALIDATE_KEYS: Record<CreateDraft['kind'], string[]> = {
  agent: ['agents'],
  capability: ['capabilities', 'capability'],
  skill: ['skills'],
  persona: ['persona'],
}

interface Props {
  draft: CreateDraft
  status: CardStatus
  onStatusChange: (status: CardStatus) => void
}

export function CreateConfirmCard({ draft, status, onStatusChange }: Props) {
  const { t } = useTranslation(['home', 'common'])
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 可编辑字段（以 LLM 草稿为初值，用户确认前可改）
  const [payload, setPayload] = useState<CreateDraft['payload']>(draft.payload)

  const patch = (p: Partial<CreateDraft['payload']>) =>
    setPayload((prev) => ({ ...prev, ...p }) as CreateDraft['payload'])

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await window.one.home
        .confirmCreate({ draftId: draft.draftId, kind: draft.kind, payload })
        .then(unwrap)
      for (const key of INVALIDATE_KEYS[draft.kind]) {
        void qc.invalidateQueries({ queryKey: [key] })
      }
      onStatusChange('saved')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const cancel = async () => {
    setBusy(true)
    try {
      await window.one.home.cancelCreate({ draftId: draft.draftId }).then(unwrap)
      onStatusChange('cancelled')
    } finally {
      setBusy(false)
    }
  }

  const kindLabel = t(`home:create.kind.${draft.kind}`)
  // persona 没有 name 字段，标题与按钮禁用条件需区分
  const isPersona = draft.kind === 'persona'
  const nonPersonaPayload = payload as Extract<CreateDraft, { kind: 'agent' | 'capability' | 'skill' }>['payload']
  const personaPayload = payload as Extract<CreateDraft, { kind: 'persona' }>['payload']
  // persona 的 instructions 可空（空 = 保留当前人设，仅更新档案），始终可确认
  const canConfirm = isPersona ? true : !!nonPersonaPayload.name?.trim()

  return (
    <div className={`create-card create-card--${status}`}>
      <div className="create-card__head">
        <span className={`create-card__badge create-card__badge--${draft.kind}`}>{kindLabel}</span>
        <span className="create-card__title">
          {status === 'saved'
            ? t('home:create.savedTitle', { name: isPersona ? kindLabel : nonPersonaPayload.name })
            : status === 'cancelled'
              ? t('home:create.cancelledTitle')
              : t('home:create.title', { kind: kindLabel })}
        </span>
      </div>

      {status === 'pending' ? (
        <>
          <div className="create-card__body">
            {isPersona ? (
              <Field label={t('home:create.field.personaInstructions')}>
                <textarea
                  className="create-card__textarea"
                  rows={10}
                  value={personaPayload.instructions ?? ''}
                  placeholder={t('home:create.field.personaKeepHint')}
                  onChange={(e) => patch({ instructions: e.target.value })}
                />
              </Field>
            ) : (
              <>
                <Field label={t('home:create.field.name')}>
                  <input
                    className="create-card__input"
                    value={nonPersonaPayload.name}
                    onChange={(e) => patch({ name: e.target.value })}
                  />
                </Field>

                <Field label={t('home:create.field.description')}>
                  <input
                    className="create-card__input"
                    value={nonPersonaPayload.description ?? ''}
                    onChange={(e) => patch({ description: e.target.value })}
                  />
                </Field>

                {draft.kind === 'agent' ? (
                  <Field label={t('home:create.field.instructions')}>
                    <textarea
                      className="create-card__textarea"
                      rows={6}
                      value={(payload as Extract<CreateDraft, { kind: 'agent' }>['payload']).instructions}
                      onChange={(e) => patch({ instructions: e.target.value })}
                    />
                  </Field>
                ) : null}

                {draft.kind === 'skill' ? (
                  <Field label={t('home:create.field.content')}>
                    <textarea
                      className="create-card__textarea"
                      rows={8}
                      value={(payload as Extract<CreateDraft, { kind: 'skill' }>['payload']).content}
                      onChange={(e) => patch({ content: e.target.value })}
                    />
                  </Field>
                ) : null}

                {draft.kind === 'capability' ? (
                  <Field label={t('home:create.field.graph')}>
                    <Suspense
                      fallback={<div className="create-card__graph create-card__graph--loading" />}
                    >
                      <GraphPreview
                        graph={(payload as Extract<CreateDraft, { kind: 'capability' }>['payload']).graph}
                      />
                    </Suspense>
                  </Field>
                ) : null}
              </>
            )}
          </div>

          {error ? <div className="create-card__error">{error}</div> : null}

          <div className="create-card__actions">
            <button
              type="button"
              className="create-card__btn create-card__btn--primary"
              onClick={() => void confirm()}
              disabled={busy || !canConfirm}
            >
              {t('home:create.confirm')}
            </button>
            <button
              type="button"
              className="create-card__btn"
              onClick={() => void cancel()}
              disabled={busy}
            >
              {t('common:actions.cancel')}
            </button>
          </div>
        </>
      ) : (
        <div className={`create-card__result create-card__result--${status}`}>
          {status === 'saved' ? t('home:create.savedHint') : t('home:create.cancelledHint')}
        </div>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="create-card__field">
      <span className="create-card__label">{label}</span>
      {children}
    </label>
  )
}
