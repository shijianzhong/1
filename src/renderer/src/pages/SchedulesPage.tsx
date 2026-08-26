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
import {
  validateCron,
  nextOccurrence,
  detectPreset,
  presetToCron,
  CRON_WEEKDAYS,
  type CronMode,
  type CronPresetState,
} from '@shared/cron'
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
    <div
      style={{
        maxWidth: 1200,
        margin: '0 auto',
        display: 'grid',
        gap: 20,
        height: '100%',
        // 第一行 PageToolbar 塌缩到内容高度，末行列表区吃剩余高度（局部滚动），
        // 避免默认行拉伸把标题行撑高
        gridTemplateRows: 'auto 1fr',
      }}
    >
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

      <div style={{ overflowY: 'auto', display: 'grid', gap: 10, alignContent: 'start', minHeight: 0 }}>
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
        background: 'var(--overlay-bg, rgba(0,0,0,0.45))',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        display: 'flex',
        justifyContent: 'flex-end',
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
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
          // 实色背景 + 强模糊：玻璃态但内容清晰可读（旧 glass-panel 0.6 透明透字）
          background: 'var(--color-bg-1)',
          borderLeft: '1px solid var(--color-border)',
          boxShadow: 'var(--shadow-3, 0 12px 32px rgba(0,0,0,0.35))',
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
          <CronField cron={cron} onChange={setCron} t={t} />
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

// —— Cron 预设编辑器：下拉选常见模式（每 N 分钟 / 每 N 小时 / 每日 / 每周 / 每月），
// 选「自定义」回退到原始 5 段输入。预设变化即生成对应 cron 字符串（受控）。
// detectPreset/presetToCron 已下沉 @shared/cron（主进程与渲染层共用，便于单测）。
const WEEKDAY_KEYS = [
  'common:schedules.weekdays.sun',
  'common:schedules.weekdays.mon',
  'common:schedules.weekdays.tue',
  'common:schedules.weekdays.wed',
  'common:schedules.weekdays.thu',
  'common:schedules.weekdays.fri',
  'common:schedules.weekdays.sat',
]

function CronField({
  cron,
  onChange,
  t,
}: {
  cron: string
  onChange: (cron: string) => void
  t: (key: string) => string
}) {
  const [preset, setPreset] = useState<CronPresetState>(() => detectPreset(cron))
  const isCustom = preset.mode === 'custom'

  // 切换模式时重新生成 cron（custom 保留原值，不改写）
  const updateMode = (mode: CronMode) => {
    const next = { ...preset, mode }
    setPreset(next)
    if (mode !== 'custom') {
      const gen = presetToCron(next)
      if (gen) onChange(gen)
    }
  }
  // 改参数即重生成并上抛
  const updateParam = (patch: Partial<CronPresetState>) => {
    const next = { ...preset, ...patch }
    setPreset(next)
    if (next.mode !== 'custom') {
      const gen = presetToCron(next)
      if (gen) onChange(gen)
    }
  }

  const numInput = (value: number, patch: (v: number) => Partial<CronPresetState>, max: number) => (
    <input
      type="number"
      min={1}
      max={max}
      value={value}
      onChange={(e) => {
        const v = Number(e.target.value)
        if (Number.isFinite(v) && v >= 1 && v <= max) updateParam(patch(v))
      }}
      className="text-input"
      style={{ width: 80 }}
    />
  )

  // HH:MM 时刻输入：TimeInput 组件持本地文本 state，光标稳定可自由编辑小时/分钟，
  // 失焦时标准化补零，避免受控补零打断光标（根因：value 重渲染重置光标）。
  const timeInput = () => (
    <TimeInput hour={preset.hour} minute={preset.minute} onChange={updateParam} />
  )

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <select
        className="text-input"
        value={preset.mode}
        onChange={(e) => updateMode(e.target.value as CronMode)}
        style={{ width: '100%' }}
      >
        <option value="everyNMin">{t('common:schedules.cronEveryNMin')}</option>
        <option value="everyNHour">{t('common:schedules.cronEveryNHour')}</option>
        <option value="dailyAt">{t('common:schedules.cronDailyAt')}</option>
        <option value="weeklyAt">{t('common:schedules.cronWeeklyAt')}</option>
        <option value="monthlyAt">{t('common:schedules.cronMonthlyAt')}</option>
        <option value="custom">{t('common:schedules.cronCustom')}</option>
      </select>

      {preset.mode === 'everyNMin' && (
        <Row>
          <Label>{t('common:schedules.cronMinutes')}</Label>
          {numInput(preset.minuteInterval, (v) => ({ minuteInterval: v }), 59)}
        </Row>
      )}
      {preset.mode === 'everyNHour' && (
        <Row>
          <Label>{t('common:schedules.cronHours')}</Label>
          {numInput(preset.hourInterval, (v) => ({ hourInterval: v }), 23)}
        </Row>
      )}
      {preset.mode === 'dailyAt' && (
        <Row>
          {timeInput()}
          <Label>{t('common:schedules.cronDailyHint')}</Label>
        </Row>
      )}
      {preset.mode === 'weeklyAt' && (
        <Row>
          <select
            className="text-input"
            value={preset.dow}
            onChange={(e) => updateParam({ dow: Number(e.target.value) })}
            style={{ width: 120 }}
          >
            {CRON_WEEKDAYS.map((dv) => (
              <option key={dv} value={dv}>
                {t(WEEKDAY_KEYS[dv])}
              </option>
            ))}
          </select>
          {timeInput()}
          <Label>{t('common:schedules.cronWeeklyHint')}</Label>
        </Row>
      )}
      {preset.mode === 'monthlyAt' && (
        <Row>
          <Label>{t('common:schedules.cronDayOfMonth')}</Label>
          {numInput(preset.dom, (v) => ({ dom: v }), 31)}
          {timeInput()}
          <Label>{t('common:schedules.cronMonthlyHint')}</Label>
        </Row>
      )}
      {isCustom && (
        <input
          className="text-input"
          value={cron}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('common:schedules.cronPh')}
          style={{ width: '100%', fontFamily: 'var(--font-mono, monospace)' }}
        />
      )}
    </div>
  )
}

// HH:MM 时刻输入——以行内文字样式直接编辑（如「每天 08:00」里直接改 08:00）。
// 用本地文本 state 持住编辑过程：onChange 只更新本地文本（不被补零打断光标），
// 仅当解析出合法 hour/minute 时上抛 cron；失焦时把显示标准化为补零形式。
// 根因：若 value 直接绑补零后的派生串，每次输入立即重算+重渲染会重置光标到开头，
// 且小时位插数字易失配正则 → 小时几乎改不动。本地 state 解开这个耦合。
function TimeInput({
  hour,
  minute,
  onChange,
}: {
  hour: number
  minute: number
  onChange: (patch: Partial<CronPresetState>) => void
}) {
  // 本地文本：初始与 props 同步（补零），编辑期间自由持住，失焦标准化
  const [text, setText] = useState(() => fmt(hour, minute))
  const [focused, setFocused] = useState(false)

  // 非编辑态下 props 变化时同步显示（如模式切换、detectPreset 反推）
  const displayed = focused ? text : fmt(hour, minute)

  return (
    <input
      type="text"
      value={displayed}
      onChange={(e) => {
        const raw = e.target.value
        setText(raw)
        // 容忍输入过程：匹配 H:MM / HH:MM / H:M / 末尾无分钟等
        const m = /^(\d{1,2}):?(\d{0,2})/.exec(raw)
        if (m) {
          const h = Number(m[1])
          const mi = m[2] === '' ? minute : Number(m[2]) // 缺分钟位时保留原值，不强制清零
          if (h >= 0 && h <= 23 && mi >= 0 && mi <= 59) {
            onChange({ hour: h, minute: mi })
          }
        }
      }}
      onFocus={(e) => {
        setFocused(true)
        setText(fmt(hour, minute))
        // 聚焦时全选，方便整体覆盖输入
        requestAnimationFrame(() => e.currentTarget.select())
      }}
      onBlur={() => {
        setFocused(false)
        // 失焦标准化：解析当前文本，合法则补零回写，非法回退到 props 值
        const m = /^(\d{1,2}):(\d{1,2})/.exec(text)
        if (m) {
          const h = Number(m[1])
          const mi = Number(m[2])
          if (h >= 0 && h <= 23 && mi >= 0 && mi <= 59) {
            onChange({ hour: h, minute: mi })
            return
          }
        }
      }}
      placeholder="08:00"
      aria-label="time"
      style={{
        width: 'auto',
        fontFamily: 'var(--font-mono, monospace)',
        fontSize: 'inherit',
        background: focused ? 'var(--color-bg-2)' : 'transparent',
        border: 'none',
        borderBottom: '1px dashed',
        borderBottomColor: focused ? 'var(--color-brand-400, #4ECDC4)' : 'var(--color-border)',
        borderRadius: 0,
        padding: '0 2px',
        color: 'var(--color-fg-1)',
        outline: 'none',
        cursor: 'text',
      }}
      size={5}
    />
  )
}

function fmt(h: number, m: number): string {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function Row({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{children}</div>
  )
}
function Label({ children }: { children: ReactNode }) {
  return <span style={{ fontSize: '0.75rem', color: 'var(--color-fg-2)' }}>{children}</span>
}
