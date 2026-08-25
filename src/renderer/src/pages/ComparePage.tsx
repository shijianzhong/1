import { useTranslation } from 'react-i18next'
import { Columns2 } from 'lucide-react'
import { Markdown } from '@renderer/components/Markdown'
import { useCompare } from '@renderer/api/hooks'
import { PageToolbar } from '@renderer/components/ui/PageToolbar'
import { Button } from '@renderer/components/ui/Button'
import { EmptyState } from '@renderer/components/ui/EmptyState'
import { Badge } from '@renderer/components/ui/Badge'

// —— 多模型并行对比（亮点③）——
// 顶部：prompt + 可选 system + 模型多选；下方按所选模型各开一栏，实时聚合各自增量。
// 状态来自 useCompare（订阅 chat:compare:stream，按 modelId 归位）。
export function ComparePage() {
  const { t } = useTranslation()
  const {
    prompt,
    setPrompt,
    system,
    setSystem,
    models,
    selectedIds,
    toggleModel,
    running,
    states,
    start,
  } = useCompare()

  const canStart = prompt.trim().length > 0 && selectedIds.length >= 2 && !running

  return (
    <div className="page compare-page">
      <PageToolbar title={t('common:compare.title')} subtitle={t('common:compare.subtitle')} />

      <div className="compare-form">
        <textarea
          className="compare-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t('common:compare.promptPlaceholder')}
          rows={4}
        />
        <input
          className="compare-system"
          value={system}
          onChange={(e) => setSystem(e.target.value)}
          placeholder={t('common:compare.systemPlaceholder')}
        />
        <div className="compare-models">
          <div className="compare-models__label">{t('common:compare.selectModels')}</div>
          <div className="compare-models__list">
            {models.map((m) => (
              <label key={m.id} className="compare-model-chip">
                <input
                  type="checkbox"
                  checked={selectedIds.includes(m.id)}
                  onChange={() => toggleModel(m.id)}
                  disabled={running}
                />
                <span className="compare-model-chip__name">{m.name ?? m.modelId}</span>
                <span className="compare-model-chip__id">{m.modelId}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="compare-actions">
          <Button onClick={start} disabled={!canStart}>
            {running ? t('common:compare.running') : t('common:compare.start')}
          </Button>
        </div>
      </div>

      {selectedIds.length === 0 ? (
        <EmptyState icon={Columns2} title={t('common:compare.empty')} />
      ) : (
        <div className="compare-grid">
          {selectedIds.map((id) => {
            const s = states[id]
            const label = s?.modelLabel ?? models.find((m) => m.id === id)?.name ?? id
            return (
              <div key={id} className="compare-col">
                <div className="compare-col__head">
                  <span className="compare-col__name">{label}</span>
                  {s?.status === 'streaming' && <Badge variant="info">{t('common:compare.running')}</Badge>}
                  {s?.status === 'done' && (
                    <Badge variant="success">{t('common:compare.chars', { count: s.textLen ?? 0 })}</Badge>
                  )}
                  {s?.status === 'error' && (
                    <Badge variant="danger">
                      {t('common:compare.failed', { message: s.messageKey ? t(s.messageKey) : s.error ?? '' })}
                    </Badge>
                  )}
                </div>
                {s?.thinking && (
                  <details className="compare-col__thinking">
                    <summary>{t('common:compare.thinking')}</summary>
                    <pre>{s.thinking}</pre>
                  </details>
                )}
                <div className="compare-col__body">
                  {s && s.text ? (
                    <Markdown>{s.text}</Markdown>
                  ) : s?.status === 'error' ? (
                    <span className="compare-col__pending">—</span>
                  ) : (
                    <span className="compare-col__pending">…</span>
                  )}
                </div>
                {s?.status === 'done' && s.stopReason && (
                  <div className="compare-col__foot">
                    {t('common:compare.stopReason', { reason: s.stopReason })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
