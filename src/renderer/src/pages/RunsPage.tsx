import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  ChevronRight,
  Clock,
  List,
  Pause,
  Play,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  ChevronLeft,
} from 'lucide-react'
import { useRuns, useRunDetail } from '@renderer/api/hooks'
import { EmptyState } from '@renderer/components/ui/EmptyState'
import { PageToolbar } from '@renderer/components/ui/PageToolbar'
import { Button } from '@renderer/components/ui/Button'
import type { RunEventInfo, RunInfo } from '@shared/types'
import {
  TONE_COLOR,
  eventIcon,
  eventLabel,
  eventTone,
  factsOf,
  formatDuration,
} from '@renderer/lib/runEventsView'
import {
  REPLAY_MIN_STEP_MS,
  buildReplayPlan,
  type ReplayPlan,
} from '@renderer/lib/runReplay'

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
// 右侧支持「回放」模式：按 seq 顺序高亮逐条播放（纯前端，复用已拉取 events，无新 IPC）。
export function RunsPage() {
  const { t, i18n } = useTranslation(['common'])
  const runsQ = useRuns()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const detailQ = useRunDetail(selectedId ?? undefined)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [replayMode, setReplayMode] = useState(false)

  const runs = runsQ.data ?? []
  // 首次加载后默认选中最近一次运行
  useEffect(() => {
    if (!selectedId && runs.length > 0) setSelectedId(runs[0].id)
  }, [runs, selectedId])

  const events = useMemo(() => detailQ.data?.events ?? [], [detailQ.data])
  const ordered = useMemo(
    () => [...events].sort((a, b) => a.seq - b.seq),
    [events],
  )
  const replay = useReplay(ordered)

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleReplay = () => {
    const next = !replayMode
    setReplayMode(next)
    if (next) replay.play()
    else replay.reset()
  }

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
    <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', gap: 20, height: '100%' }}>
      <PageToolbar
        title={t('common:runs.title')}
        subtitle={t('common:runs.description')}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={toggleReplay}>
              {replayMode ? <List size={14} /> : <PlayCircle size={14} />}
              {replayMode ? t('common:runs.timeline') : t('common:runs.replay')}
            </Button>
            <Button variant="ghost" size="sm" onClick={refresh}>
              <RefreshCw size={14} />
              {t('common:runs.refresh')}
            </Button>
          </>
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

        {/* 右侧：事件时间线 / 回放 */}
        <div style={{ overflowY: 'auto', minHeight: 0 }}>
          {!selectedId ? (
            <EmptyState text={t('common:runs.noSelection')} />
          ) : detailQ.isLoading ? (
            <EmptyState text={t('common:state.loading')} />
          ) : events.length === 0 ? (
            <EmptyState text={t('common:runs.noEvents')} />
          ) : (
            <>
              {replayMode && <ReplayBar replay={replay} t={t} />}
              <Timeline
                events={ordered}
                lang={i18n.language}
                t={t}
                timeFmt={timeFmt}
                expanded={expanded}
                onToggle={toggle}
                replayCursor={replayMode ? replay.cursor : null}
                onSeek={replay.seek}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// —— 回放状态机（纯前端，由 buildReplayPlan 推导的节奏驱动）——
interface ReplayController {
  plan: ReplayPlan
  n: number
  cursor: number
  playing: boolean
  speed: number
  done: boolean
  play: () => void
  pause: () => void
  reset: () => void
  stepBack: () => void
  stepForward: () => void
  seek: (i: number) => void
  setSpeed: (s: number) => void
}

function useReplay(events: RunEventInfo[]): ReplayController {
  const plan = useMemo(() => buildReplayPlan(events), [events])
  const n = plan.steps.length
  const [cursor, setCursor] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const done = cursor >= n

  // 切换运行（events 引用变化）→ 重置回放态
  useEffect(() => {
    setCursor(0)
    setPlaying(false)
  }, [events])

  // 自动推进：playing 时按 plan.steps[cursor].delayMs / speed 排程下一步
  useEffect(() => {
    if (done) {
      if (playing) setPlaying(false)
      return
    }
    if (!playing) return
    const step = plan.steps[cursor]
    const delay = Math.max(60, (step?.delayMs ?? REPLAY_MIN_STEP_MS) / speed)
    timer.current = setTimeout(() => setCursor((c) => Math.min(c + 1, n)), delay)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [playing, cursor, speed, plan, n, done])

  const play = useCallback(() => {
    if (n === 0) return
    setCursor((c) => (c >= n ? 0 : c))
    setPlaying(true)
  }, [n])
  const pause = useCallback(() => setPlaying(false), [])
  const reset = useCallback(() => {
    setPlaying(false)
    setCursor(0)
  }, [])
  const stepBack = useCallback(() => {
    setPlaying(false)
    setCursor((c) => Math.max(0, c - 1))
  }, [])
  const stepForward = useCallback(() => {
    setPlaying(false)
    setCursor((c) => Math.min(n, c + 1))
  }, [n])
  const seek = useCallback(
    (i: number) => {
      setPlaying(false)
      setCursor(Math.min(Math.max(0, i), n))
    },
    [n],
  )
  const setSpeedSafe = useCallback((s: number) => setSpeed(s), [])

  return { plan, n, cursor, playing, speed, done, play, pause, reset, stepBack, stepForward, seek, setSpeed: setSpeedSafe }
}

function ReplayBar({
  replay,
  t,
}: {
  replay: ReplayController
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  const disabled = replay.n === 0
  return (
    <div className="replay-bar">
      <button
        type="button"
        className="replay-btn"
        title={t('common:runs.replayReset')}
        disabled={disabled}
        onClick={replay.reset}
      >
        <RotateCcw size={15} />
      </button>
      <button
        type="button"
        className="replay-btn"
        title={t('common:runs.replayStepBack')}
        disabled={disabled || replay.cursor === 0}
        onClick={replay.stepBack}
      >
        <ChevronLeft size={16} />
      </button>
      {replay.playing ? (
        <button
          type="button"
          className="replay-btn replay-btn--primary"
          title={t('common:runs.replayPause')}
          disabled={disabled}
          onClick={replay.pause}
        >
          <Pause size={15} />
        </button>
      ) : (
        <button
          type="button"
          className="replay-btn replay-btn--primary"
          title={t('common:runs.replayPlay')}
          disabled={disabled}
          onClick={replay.play}
        >
          <Play size={15} />
        </button>
      )}
      <button
        type="button"
        className="replay-btn"
        title={t('common:runs.replayStepForward')}
        disabled={disabled || replay.done}
        onClick={replay.stepForward}
      >
        <ChevronRight size={16} />
      </button>

      <span className="replay-bar__progress">
        {t('common:runs.replayProgress', { current: replay.cursor, total: replay.n })}
      </span>

      <input
        className="replay-bar__range"
        type="range"
        min={0}
        max={replay.n}
        value={replay.cursor}
        disabled={disabled}
        onChange={(e) => replay.seek(Number(e.target.value))}
      />

      <label className="replay-bar__speed">
        {t('common:runs.replaySpeed')}
        <select
          value={replay.speed}
          onChange={(e) => replay.setSpeed(Number(e.target.value))}
          disabled={disabled}
        >
          <option value={1}>1x</option>
          <option value={2}>2x</option>
          <option value={4}>4x</option>
        </select>
      </label>

      {replay.done && !disabled && <span className="replay-bar__done">✓ {t('common:runs.replayDone')}</span>}
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
  replayCursor,
  onSeek,
}: {
  events: RunEventInfo[]
  lang: string
  t: (key: string) => string
  timeFmt: Intl.DateTimeFormat
  expanded: Set<number>
  onToggle: (id: number) => void
  replayCursor: number | null
  onSeek: (i: number) => void
}) {
  const replaying = replayCursor !== null
  return (
    <div style={{ display: 'grid', paddingLeft: 4 }}>
      {events.map((ev, i) => {
        const tone = eventTone(ev.type)
        const color = TONE_COLOR[tone]
        const Icon = eventIcon(ev.type)
        const isLast = i === events.length - 1
        const isOpen = expanded.has(ev.id)
        const facts = factsOf(ev.payload)
        const isFuture = replaying && i >= replayCursor!
        const isActive = replaying && i === replayCursor! - 1
        const replayClass = isActive ? 'replay-event--active' : isFuture ? 'replay-event--future' : ''
        return (
          <div key={ev.id} style={{ display: 'grid', gridTemplateColumns: '22px 1fr', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <button
                type="button"
                onClick={() => replaying && onSeek(i)}
                disabled={!replaying}
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  background: color,
                  marginTop: 4,
                  flexShrink: 0,
                  border: 'none',
                  padding: 0,
                  cursor: replaying ? 'pointer' : 'default',
                  opacity: isFuture ? 0.35 : 1,
                }}
                title={replaying ? t('common:runs.replaySeek') : undefined}
              />
              {!isLast && (
                <span style={{ width: 2, flex: 1, background: 'var(--color-border)', margin: '2px 0' }} />
              )}
            </div>
            <div style={{ paddingBottom: isLast ? 0 : 16 }}>
              <div
                className={`surface-panel ${replayClass}`}
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
