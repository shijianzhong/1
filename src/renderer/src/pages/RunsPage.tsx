import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Clock, RefreshCw } from 'lucide-react'
import { useRuns, useRunDetail } from '@renderer/api/hooks'
import { EmptyState } from '@renderer/components/ui/EmptyState'
import { PageToolbar } from '@renderer/components/ui/PageToolbar'
import type { RunEventInfo, RunInfo } from '@shared/types'
import {
  TONE_COLOR,
  eventIcon,
  eventLabel,
  eventTone,
  factsOf,
  formatDuration,
} from '@renderer/lib/runEventsView'

type Tone = 'success' | 'danger' | 'warning' | 'info' | 'neutral'

function statusTone(status: string): Tone {
  switch (status) {
    case 'running':
      return 'info'
    case 'done':
      return 'success'
    case 'failed':
      return 'danger'
    case 'crashed':
      return 'warning'
    default:
      return 'neutral'
  }
}

// —— 运行诊断页（runs / run_events 事实流可视化）——
// 主从布局：左侧运行列表（按开始时间倒序），右侧选中运行的事件时间线。
export function RunsPage() {
  const { t, i18n } = useTranslation(['common'])
  const runsQ = useRuns()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const detailQ = useRunDetail(selectedId ?? undefined)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  const runs = runsQ.data ?? []
  // 首次加载后默认选中最近一次运行
  useEffect(() => {
    if (!selectedId && runs.length > 0) setSelectedId(runs[0].id)
  }, [runs, selectedId])

  const events = detailQ.data?.events ?? []

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    [i18n.language],
  )
  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
    [i18n.language],
  )

  const refresh = () => {
    void runsQ.refetch()
    if (selectedId) void detailQ.refetch()
  }

  return (
    <div style={{ display: 'grid', gap: 20, height: '100%' }}>
      <PageToolbar
        title={t('common:runs.title')}
        subtitle={t('common:runs.description')}
        actions={
          <button
            type="button"
            className="nav-button"
            onClick={refresh}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px' }}
          >
            <RefreshCw size={14} />
            {t('common:runs.refresh')}
          </button>
        }
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '300px minmax(0,1fr)',
          gap: 16,
          minHeight: 0,
          flex: 1,
        }}
      >
        {/* 左侧：运行列表 */}
        <div style={{ overflowY: 'auto', display: 'grid', gap: 8, alignContent: 'start', minHeight: 0 }}>
          {runsQ.isLoading ? (
            <EmptyState text={t('common:state.loading')} />
          ) : runs.length === 0 ? (
            <EmptyState text={t('common:runs.empty')} hint={t('common:runs.emptyHint')} />
          ) : (
            runs.map((r) => (
              <RunCard
                key={r.id}
                run={r}
                active={r.id === selectedId}
                now={Date.now()}
                t={t}
                dateFmt={dateFmt}
                onSelect={() => setSelectedId(r.id)}
              />
            ))
          )}
        </div>

        {/* 右侧：事件时间线 */}
        <div style={{ overflowY: 'auto', minHeight: 0 }}>
          {!selectedId ? (
            <EmptyState text={t('common:runs.noSelection')} />
          ) : detailQ.isLoading ? (
            <EmptyState text={t('common:state.loading')} />
          ) : events.length === 0 ? (
            <EmptyState text={t('common:runs.noEvents')} />
          ) : (
            <Timeline events={events} lang={i18n.language} t={t} timeFmt={timeFmt} expanded={expanded} onToggle={toggle} />
          )}
        </div>
      </div>
    </div>
  )
}

function RunCard({
  run,
  active,
  now,
  t,
  dateFmt,
  onSelect,
}: {
  run: RunInfo
  active: boolean
  now: number
  t: (key: string) => string
  dateFmt: Intl.DateTimeFormat
  onSelect: () => void
}) {
  const tone = statusTone(run.status)
  const finished = run.endedAt != null
  const durationMs = finished
    ? run.endedAt! - run.startedAt
    : run.status === 'running'
      ? now - run.startedAt
      : null
  return (
    <button
      type="button"
      onClick={onSelect}
      className="surface-panel"
      style={{
        textAlign: 'left',
        borderRadius: 16,
        padding: '12px 14px',
        border: active ? '1px solid var(--color-brand-400)' : '1px solid var(--color-border)',
        cursor: 'pointer',
        background: active
          ? 'color-mix(in oklch, var(--color-brand-400) 10%, var(--color-surface))'
          : 'var(--color-surface)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span className="section-title" style={{ fontSize: '0.85rem' }}>
          {t(`common:runs.entry.${run.entry}`)}
        </span>
        <StatusPill status={run.status} t={t} />
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: 6,
          fontSize: '0.75rem',
          color: 'var(--color-fg-2)',
        }}
      >
        <span>{t(`common:runs.route.${run.route ?? 'none'}`)}</span>
        <span>{dateFmt.format(run.startedAt)}</span>
      </div>
      <div
        style={{
          marginTop: 6,
          fontSize: '0.72rem',
          color: 'var(--color-fg-2)',
          display: 'flex',
          gap: 6,
          alignItems: 'center',
        }}
      >
        <Clock size={12} /> {formatDuration(durationMs)}
      </div>
    </button>
  )
}

function StatusPill({ status, t }: { status: string; t: (key: string) => string }) {
  const color = TONE_COLOR[statusTone(status)]
  return (
    <span
      style={{
        fontSize: '0.7rem',
        color,
        border: `1px solid ${color}`,
        borderRadius: 999,
        padding: '1px 8px',
        whiteSpace: 'nowrap',
      }}
    >
      {t(`common:runs.status.${status}`)}
    </span>
  )
}

function Timeline({
  events,
  lang,
  t,
  timeFmt,
  expanded,
  onToggle,
}: {
  events: RunEventInfo[]
  lang: string
  t: (key: string) => string
  timeFmt: Intl.DateTimeFormat
  expanded: Set<number>
  onToggle: (id: number) => void
}) {
  return (
    <div style={{ display: 'grid', paddingLeft: 4 }}>
      {events.map((ev, i) => {
        const tone = eventTone(ev.type)
        const color = TONE_COLOR[tone]
        const Icon = eventIcon(ev.type)
        const isLast = i === events.length - 1
        const isOpen = expanded.has(ev.id)
        const facts = factsOf(ev.payload)
        return (
          <div key={ev.id} style={{ display: 'grid', gridTemplateColumns: '22px 1fr', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  background: color,
                  marginTop: 4,
                  flexShrink: 0,
                }}
              />
              {!isLast && (
                <span style={{ width: 2, flex: 1, background: 'var(--color-border)', margin: '2px 0' }} />
              )}
            </div>
            <div style={{ paddingBottom: isLast ? 0 : 16 }}>
              <div
                className="surface-panel"
                style={{ borderRadius: 14, padding: '10px 12px', border: '1px solid var(--color-border)' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Icon size={15} style={{ color }} />
                  <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{eventLabel(ev.type, lang)}</span>
                  <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--color-fg-2)' }}>
                    {timeFmt.format(ev.createdAt)}
                  </span>
                  <span style={{ fontSize: '0.68rem', color: 'var(--color-fg-3)' }}>#{ev.seq}</span>
                </div>

                {facts.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                    {facts.map((f) => (
                      <span
                        key={f.k}
                        style={{
                          fontSize: '0.72rem',
                          background: 'var(--color-bg-2)',
                          borderRadius: 8,
                          padding: '2px 7px',
                          color: 'var(--color-fg-1)',
                        }}
                      >
                        <span style={{ color: 'var(--color-fg-2)' }}>{f.k}</span>=
                        <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{f.v}</span>
                      </span>
                    ))}
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => onToggle(ev.id)}
                  style={{
                    marginTop: 8,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    background: 'none',
                    border: 'none',
                    color: 'var(--color-fg-2)',
                    cursor: 'pointer',
                    fontSize: '0.72rem',
                    padding: 0,
                  }}
                >
                  {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {t('common:runs.raw')}
                </button>
                {isOpen && (
                  <pre
                    style={{
                      marginTop: 8,
                      background: 'var(--color-bg-2)',
                      borderRadius: 10,
                      padding: 10,
                      fontSize: '0.72rem',
                      overflowX: 'auto',
                      color: 'var(--color-fg-1)',
                      maxHeight: 320,
                      overflowY: 'auto',
                      marginBottom: 0,
                    }}
                  >
                    {JSON.stringify(ev.payload, null, 2)}
                  </pre>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
