import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ReactFlow, Background, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { unwrap } from '@renderer/api/client'
import type { CreateDraft, WorkflowGraph } from '@shared/types'

// —— 创建确认卡（聊天创建闭环的前端落点）——
// 主 Agent 调 propose_* → 后端 emit proposal → 此卡渲染草稿（字段可编辑）。
// 用户点「确认入库」→ home:confirmCreate（以编辑后 payload 落库）→ 卡片定「已入库」；
// 点「取消」→ home:cancelCreate（丢弃草稿）→ 卡片定「已取消」。

export type CardStatus = 'pending' | 'saved' | 'cancelled'

interface Props {
  draft: CreateDraft
  status: CardStatus
  onStatusChange: (status: CardStatus) => void
}

export function CreateConfirmCard({ draft, status, onStatusChange }: Props) {
  const { t } = useTranslation(['home', 'common'])
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

  return (
    <div className={`create-card create-card--${status}`}>
      <div className="create-card__head">
        <span className={`create-card__badge create-card__badge--${draft.kind}`}>{kindLabel}</span>
        <span className="create-card__title">
          {status === 'saved'
            ? t('home:create.savedTitle', { name: payload.name })
            : status === 'cancelled'
              ? t('home:create.cancelledTitle')
              : t('home:create.title', { kind: kindLabel })}
        </span>
      </div>

      {status === 'pending' ? (
        <>
          <div className="create-card__body">
            <Field label={t('home:create.field.name')}>
              <input
                className="create-card__input"
                value={payload.name}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </Field>

            <Field label={t('home:create.field.description')}>
              <input
                className="create-card__input"
                value={payload.description ?? ''}
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
                <GraphPreview
                  graph={(payload as Extract<CreateDraft, { kind: 'capability' }>['payload']).graph}
                />
              </Field>
            ) : null}
          </div>

          {error ? <div className="create-card__error">{error}</div> : null}

          <div className="create-card__actions">
            <button
              type="button"
              className="create-card__btn create-card__btn--primary"
              onClick={() => void confirm()}
              disabled={busy || !payload.name.trim()}
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

/** 能力编排图只读缩略预览（所见即所得，禁交互） */
function GraphPreview({ graph }: { graph: WorkflowGraph }) {
  const { rfNodes, rfEdges } = useMemo(() => {
    const ns: Node[] = graph.nodes.map((n) => ({
      id: n.id,
      position: n.position,
      data: { label: (n.data as { label?: string }).label ?? n.id },
      draggable: false,
    }))
    const es: Edge[] = graph.edges.map((e, i) => ({
      id: `e${i}`,
      source: e.source,
      target: e.target,
      label: e.condition,
    }))
    return { rfNodes: ns, rfEdges: es }
  }, [graph])

  return (
    <div className="create-card__graph">
      <ReactFlow nodes={rfNodes} edges={rfEdges} fitView nodesDraggable={false} nodesConnectable={false}
        elementsSelectable={false} zoomOnScroll={false} panOnDrag={false} proOptions={{ hideAttribution: true }}>
        <Background gap={16} />
      </ReactFlow>
    </div>
  )
}
