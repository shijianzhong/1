import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CalendarClock,
  Check,
  ChevronRight,
  Clock,
  Pencil,
  Play,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { validateCron, nextOccurrence } from '@shared/cron'
import {
  useCreateSchedule,
  useRemoveSchedule,
  useRunScheduleNow,
  useSchedules,
  useToggleSchedule,
  useUpdateSchedule,
} from '@renderer/api/hooks'
import { errorMessage } from '@renderer/api/client'
import { EmptyState } from '@renderer/components/ui/EmptyState'
import { PageToolbar } from '@renderer/components/ui/PageToolbar'
import { Button } from '@renderer/components/ui/Button'
import { confirmDialog } from '@renderer/components/ui/ConfirmDialog'
import type { Schedule, ScheduleAction } from '@shared/types'

// —— 定时任务页（§定时任务）——
// 列表 + 右侧抽屉编辑器：名称/启用/cron（实时校验+下次运行预览）/时区/触发目标
// （orchestration 提示词 或 shell 命令+参数+cwd+超时）/立即运行/最近运行。

/**
 * 解析 shell 参数文本：支持单/双引号包裹含空格的参数（如 '/Applications/My App.app'）。
 * 与 shell 行为一致：引号内的空格不拆分，引号外的空白为分隔符。
 * 简易实现，不处理转义（参数路径含引号本身极少见）。
 */
function parseArgs(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const args: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (cur) {
        args.push(cur)
        cur = ''
      }
    } else {
      cur += ch
    }
  }
  if (cur) args.push(cur)
  return args
}

/** cron 是否合法（与主进程共用 @shared/cron.validateCron，避免漂移 #13） */
function cronValid(cron: string): boolean {
  return validateCron(cron).valid
}

/** 下次运行：from（缺省当前）之后的下一个命中时刻（带时区）；解析失败返回 null */
function computeNext(cron: string, tz: string | undefined, from: Date = new Date()): Date | null {
  return nextOccurrence(cron, from, tz || undefined)
}

export function SchedulesPage() {
  const { t, i18n } = useTranslation(['common', 'errors'])
  const schedulesQ = useSchedules()
  const createM = useCreateSchedule()
  const updateM = useUpdateSchedule()
  const removeM = useRemoveSchedule()
  const toggleM = useToggleSchedule()
  const runNowM = useRunScheduleNow()

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState<Schedule | null>(null)
  const [runError, setRunError] = useState<string | null>(null)

  const schedules = schedulesQ.data ?? []

  const openNew = () => {
    setEditing(null)
    setDrawerOpen(true)
  }
  const openEdit = (s: Schedule) => {
    setEditing(s)
    setDrawerOpen(true)
  }

  const handleRun = async (s: Schedule) => {
    setRunError(null)
    try {
      const r = await runNowM.mutateAsync(s.id)
      if (!r.ok) {
        setRunError(r.messageKey ? t(r.messageKey) : t('errors:schedules.not_found'))
      }
    } catch (e) {
      setRunError(errorMessage(e, t))
    }
  }

  const handleDelete = async (s: Schedule) => {
    const ok = await confirmDialog({
      title: t('common:schedules.confirmDelete'),
      confirmText: t('common:actions.delete'),
    })
    if (ok) removeM.mutate(s.id)
  }

  return (
    <div style={{ display: 'grid', gap: 20, height: '100%' }}>
      <PageToolbar
        title={t('common:schedules.title')}
        subtitle={t('common:schedules.subtitle')}
        actions={
          <Button variant="default" size="sm" onClick={openNew}>
            <Plus size={14} />
            {t('common:schedules.new')}
          </Button>
        }
      />

      {runError && (
        <div
          role="alert"
          style={{
            background: 'color-mix(in oklch, var(--color-danger, #e5484d) 12%, transparent)',
            border: '1px solid var(--color-danger, #e5484d)',
            color: 'var(--color-danger, #e5484d)',
            borderRadius: 12,
            padding: '8px 12px',
            fontSize: '0.8rem',
          }}
        >
          {runError}
        </div>
      )}

      <div style={{ overflowY: 'auto', display: 'grid', gap: 10, alignContent: 'start', minHeight: 0 }}>
        {schedulesQ.isLoading ? (
          <EmptyState text={t('common:state.loading')} />
        ) : schedules.length === 0 ? (
          <EmptyState text={t('common:schedules.empty')} hint={t('common:schedules.emptyHint')} />
        ) : (
          schedules.map((s) => (
            <ScheduleCard
              key={s.id}
              s={s}
              t={t}
              lang={i18n.language}
              onToggle={(enabled) => toggleM.mutate({ id: s.id, enabled })}
              onRun={() => void handleRun(s)}
              onEdit={() => openEdit(s)}
              onDelete={() => void handleDelete(s)}
            />
          ))
        )}
      </div>

      {drawerOpen && (
        <ScheduleDrawer
          schedule={editing}
          t={t}
          lang={i18n.language}
          onClose={() => setDrawerOpen(false)}
          onCreate={(input) => createM.mutateAsync(input)}
          onUpdate={(input) => updateM.mutateAsync(input)}
        />
      )}
    </div>
  )
}

function ScheduleCard({
  s,
  t,
  lang,
  onToggle,
  onRun,
  onEdit,
  onDelete,
}: {
  s: Schedule
  t: (key: string) => string
  lang: string
  onToggle: (enabled: boolean) => void
  onRun: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const fmt = useMemo(
    () => new Intl.DateTimeFormat(lang, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
    [lang],
  )
  // memo：parseExpression 较重，父级任何状态变更都会重渲所有卡片，缓存避免重复解析（#12）
  const next = useMemo(() => computeNext(s.cron, s.timezone), [s.cron, s.timezone])
  const isOrch = s.action.type === 'orchestration'

  return (
    <div
      className="surface-panel"
      style={{
        borderRadius: 16,
        padding: '12px 14px',
        border: '1px solid var(--color-border)',
        display: 'grid',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          type="button"
          onClick={() => onToggle(!s.enabled)}
          title={t('common:schedules.toggleEnable')}
          aria-pressed={s.enabled}
          style={{
            width: 38,
            height: 22,
            borderRadius: 999,
            border: 'none',
            cursor: 'pointer',
            padding: 2,
            background: s.enabled ? 'var(--color-brand-400, #4ECDC4)' : 'var(--color-bg-3, #ccc)',
            transition: 'background .15s',
          }}
        >
          <span
            style={{
              display: 'block',
              width: 18,
              height: 18,
              borderRadius: '50%',
              background: '#fff',
              marginLeft: s.enabled ? 16 : 0,
              transition: 'margin-left .15s',
            }}
          />
        </button>
        <span className="section-title" style={{ fontSize: '0.95rem', opacity: s.enabled ? 1 : 0.55 }}>
          {s.name}
        </span>
        <span
          style={{
            fontSize: '0.68rem',
            borderRadius: 999,
            padding: '1px 8px',
            border: '1px solid var(--color-border)',
            color: 'var(--color-fg-2)',
            whiteSpace: 'nowrap',
          }}
        >
          {isOrch ? t('common:schedules.actionOrchestration') : t('common:schedules.actionShell')}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <IconBtn title={t('common:schedules.runNow')} onClick={onRun}>
            <Play size={15} />
          </IconBtn>
          <IconBtn title={t('common:actions.edit')} onClick={onEdit}>
            <Pencil size={15} />
          </IconBtn>
          <IconBtn title={t('common:actions.delete')} onClick={onDelete}>
            <Trash2 size={15} />
          </IconBtn>
        </div>
      </div>

      <code
        style={{
          fontSize: '0.78rem',
          fontFamily: 'var(--font-mono, monospace)',
          background: 'var(--color-bg-2)',
          borderRadius: 8,
          padding: '3px 8px',
          color: 'var(--color-fg-1)',
          justifySelf: 'start',
        }}
      >
        {s.cron}
        {s.timezone ? `  (${s.timezone})` : ''}
      </code>

      <div
        style={{
          display: 'flex',
          gap: 16,
          fontSize: '0.72rem',
          color: 'var(--color-fg-2)',
          alignItems: 'center',
        }}
      >
        <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
          <CalendarClock size={13} />
          {t('common:schedules.nextRun')}：{next ? fmt.format(next) : t('common:schedules.never')}
        </span>
        <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
          <Clock size={13} />
          {t('common:schedules.lastRun')}：
          {s.lastFiredAt ? fmt.format(s.lastFiredAt) : t('common:schedules.neverRun')}
        </span>
      </div>
    </div>
  )
}

function IconBtn({
  children,
  title,
  onClick,
}: {
  children: ReactNode
  title: string
  onClick: () => void
}) {
  return (
    <Button variant="ghost" size="icon" title={title} aria-label={title} onClick={onClick}>
      {children}
    </Button>
  )
}

// —— 编辑抽屉（新建/编辑共用）——
function ScheduleDrawer({
  schedule,
  t,
  lang,
  onClose,
  onCreate,
  onUpdate,
}: {
  schedule: Schedule | null
  t: (key: string) => string
  lang: string
  onClose: () => void
  onCreate: (input: {
    name: string
    enabled: boolean
    cron: string
    timezone?: string
    action: ScheduleAction
    notifyOnComplete?: boolean
  }) => Promise<unknown>
  onUpdate: (input: {
    id: string
    name?: string
    enabled?: boolean
    cron?: string
    timezone?: string
    action?: ScheduleAction
    notifyOnComplete?: boolean
  }) => Promise<unknown>
}) {
  const isEdit = !!schedule
  const [name, setName] = useState(schedule?.name ?? '')
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true)
  const [cron, setCron] = useState(schedule?.cron ?? '0 9 * * 1-5')
  const [timezone, setTimezone] = useState(schedule?.timezone ?? '')
  const [actionType, setActionType] = useState<ScheduleAction['type']>(
    schedule?.action.type ?? 'orchestration',
  )
  const [prompt, setPrompt] = useState(
    schedule?.action.type === 'orchestration' ? schedule.action.prompt : '',
  )
  const [command, setCommand] = useState(
    schedule?.action.type === 'shell' ? schedule.action.command : '',
  )
  const [argsText, setArgsText] = useState(
    schedule?.action.type === 'shell' ? (schedule.action.args ?? []).join(' ') : '',
  )
  const [cwd, setCwd] = useState(schedule?.action.type === 'shell' ? schedule.action.cwd ?? '' : '')
  const [timeoutMs, setTimeoutMs] = useState<string>(
    schedule?.action.type === 'shell' ? String(schedule.action.timeoutMs ?? 60000) : '60000',
  )
  const [notify, setNotify] = useState(schedule?.notifyOnComplete ?? false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cronOk = cronValid(cron)
  const fmt = useMemo(
    () => new Intl.DateTimeFormat(lang, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
    [lang],
  )
  const next = cronOk ? computeNext(cron, timezone || undefined) : null

  const nameOk = name.trim().length > 0
  const promptOk = actionType === 'orchestration' ? prompt.trim().length > 0 : true
  const commandOk = actionType === 'shell' ? command.trim().length > 0 : true
  const timeoutOk = /^\d+$/.test(timeoutMs.trim()) && Number(timeoutMs.trim()) > 0
  const valid = nameOk && cronOk && promptOk && commandOk && timeoutOk

  const save = async () => {
    setError(null)
    if (!valid) return
    const action: ScheduleAction =
      actionType === 'orchestration'
        ? { type: 'orchestration', prompt: prompt.trim() }
        : {
            type: 'shell',
            command: command.trim(),
            args: (() => {
              const a = parseArgs(argsText)
              return a.length ? a : undefined
            })(),
            cwd: cwd.trim() || undefined,
            timeoutMs: Number(timeoutMs.trim()),
          }
    const base = {
      name: name.trim(),
      enabled,
      cron: cron.trim(),
      timezone: timezone.trim() || undefined,
      action,
      notifyOnComplete: notify,
    }
    setSaving(true)
    try {
      if (isEdit) {
        await onUpdate({ id: schedule!.id, ...base })
      } else {
        await onCreate(base)
      }
      onClose()
    } catch (e) {
      setError(errorMessage(e, t))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex',
        justifyContent: 'flex-end',
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
        className="glass-panel"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(520px, 92vw)',
          height: '100%',
          overflowY: 'auto',
          padding: 24,
          borderRadius: '20px 0 0 20px',
          display: 'grid',
          gap: 16,
          alignContent: 'start',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <h2 className="section-title" style={{ fontSize: '1.05rem' }}>
            {isEdit ? t('common:schedules.edit') : t('common:schedules.new')}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label={t('common:actions.close')}
            style={{ marginLeft: 'auto' }}
          >
            <X size={16} />
          </Button>
        </div>

        {error && (
          <div
            role="alert"
            style={{
              background: 'color-mix(in oklch, var(--color-danger, #e5484d) 12%, transparent)',
              border: '1px solid var(--color-danger, #e5484d)',
              color: 'var(--color-danger, #e5484d)',
              borderRadius: 10,
              padding: '8px 10px',
              fontSize: '0.78rem',
            }}
          >
            {error}
          </div>
        )}

        <Field label={t('common:schedules.name')}>
          <input
            className="text-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('common:schedules.name')}
            style={{ width: '100%' }}
          />
        </Field>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85rem' }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t('common:schedules.enabled')}
        </label>

        <Field label={t('common:schedules.cron')}>
          <input
            className="text-input"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder={t('common:schedules.cronPh')}
            style={{ width: '100%', fontFamily: 'var(--font-mono, monospace)' }}
          />
          {!cronOk ? (
            <span style={{ color: 'var(--color-danger, #e5484d)', fontSize: '0.72rem' }}>
              {t('common:schedules.cronInvalid')}
            </span>
          ) : next ? (
            <span style={{ color: 'var(--color-fg-2)', fontSize: '0.72rem' }}>
              {t('common:schedules.nextRun')}：{fmt.format(next)}
            </span>
          ) : null}
        </Field>

        <Field label={t('common:schedules.timezone')}>
          <input
            className="text-input"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder={t('common:schedules.timezonePh')}
            style={{ width: '100%' }}
          />
        </Field>

        <Field label={t('common:schedules.actionType')}>
          <div style={{ display: 'flex', gap: 8 }}>
            <Segmented
              active={actionType === 'orchestration'}
              onClick={() => setActionType('orchestration')}
              label={t('common:schedules.actionOrchestration')}
            />
            <Segmented
              active={actionType === 'shell'}
              onClick={() => setActionType('shell')}
              label={t('common:schedules.actionShell')}
            />
          </div>
        </Field>

        {actionType === 'orchestration' ? (
          <Field label={t('common:schedules.prompt')}>
            <textarea
              className="text-input"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t('common:schedules.promptPh')}
              rows={4}
              style={{ width: '100%', resize: 'vertical' }}
            />
          </Field>
        ) : (
          <>
            <Field label={t('common:schedules.command')}>
              <input
                className="text-input"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder={t('common:schedules.commandPh')}
                style={{ width: '100%', fontFamily: 'var(--font-mono, monospace)' }}
              />
            </Field>
            <Field label={t('common:schedules.args')}>
              <input
                className="text-input"
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder={t('common:schedules.argsPh')}
                style={{ width: '100%', fontFamily: 'var(--font-mono, monospace)' }}
              />
            </Field>
            <Field label={t('common:schedules.cwd')}>
              <input
                className="text-input"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder={t('common:schedules.cwdPh')}
                style={{ width: '100%' }}
              />
            </Field>
            <Field label={t('common:schedules.timeout')}>
              <input
                className="text-input"
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(e.target.value)}
                placeholder="60000"
                style={{ width: '100%' }}
              />
            </Field>
          </>
        )}

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85rem' }}>
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
          {t('common:schedules.notify')}
        </label>

        <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
          <Button variant="default" size="sm" disabled={!valid || saving} onClick={() => void save()}>
            {saving ? <span className="spinner" /> : <Check size={15} />}
            {t('common:actions.save')}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
        </div>

        {!valid && (
          <p style={{ color: 'var(--color-fg-2)', fontSize: '0.72rem', margin: 0 }}>
            <ChevronRight size={12} style={{ verticalAlign: '-2px' }} />
            {!nameOk
              ? t('common:schedules.name')
              : !cronOk
                ? t('common:schedules.cronInvalid')
                : !promptOk
                  ? t('common:schedules.prompt')
                  : !commandOk
                    ? t('common:schedules.command')
                    : !timeoutOk
                      ? t('common:schedules.timeout')
                      : ''}
          </p>
        )}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 6, fontSize: '0.82rem', color: 'var(--color-fg-1)' }}>
      <span style={{ fontWeight: 600 }}>{label}</span>
      {children}
    </label>
  )
}

function Segmented({
  active,
  onClick,
  label,
}: {
  active: boolean
  onClick: () => void
  label: string
}) {
  return (
    <Button
      type="button"
      variant={active ? 'outline' : 'ghost'}
      size="sm"
      onClick={onClick}
      style={
        active
          ? {
              borderColor: 'var(--color-brand-400, #4ECDC4)',
              background: 'color-mix(in oklch, var(--color-brand-400) 12%, transparent)',
              color: 'var(--color-brand-400, #4ECDC4)',
            }
          : undefined
      }
    >
      {label}
    </Button>
  )
}
