import type { LucideIcon } from 'lucide-react'
import { Activity, Cpu, GitBranch, Home, Wrench, Zap } from 'lucide-react'

// —— 运行诊断时间线的纯展示逻辑（无 DOM / 无 i18n 依赖，便于单测）——
// 事件类型由主进程 run_events 事实流定义（docs/DEEPSEEK_HARNESS_LEARNING_PLAN P0）。
// 这里只负责「类型 → 友好标签 / 色调 / 图标」与「payload → 关键字段」的映射。

export type EventTone = 'success' | 'danger' | 'warning' | 'info' | 'brand' | 'neutral'

export interface EventMeta {
  label: { zh: string; en: string }
  tone: EventTone
}

// 已登记事件的元数据；未知类型回退到 humanizeType（保持可读、不丢信息）。
export const EVENT_META: Record<string, EventMeta> = {
  'tool.prechecked': { label: { zh: '工具预检拦截', en: 'Tool precheck blocked' }, tone: 'warning' },
  'tool.approval.requested': { label: { zh: '审批请求', en: 'Approval requested' }, tone: 'info' },
  'tool.approval.decided': { label: { zh: '审批决定', en: 'Approval decided' }, tone: 'neutral' },
  'tool.started': { label: { zh: '工具开始执行', en: 'Tool started' }, tone: 'info' },
  'tool.completed': { label: { zh: '工具执行完成', en: 'Tool completed' }, tone: 'success' },
  'tool.failed': { label: { zh: '工具执行失败', en: 'Tool failed' }, tone: 'danger' },
  'node.cache_truncated': { label: { zh: '节点上下文截断', en: 'Node context truncated' }, tone: 'warning' },
  'node.cache_extended': { label: { zh: '节点上下文扩展', en: 'Node context extended' }, tone: 'info' },
  'node.started': { label: { zh: '节点开始', en: 'Node started' }, tone: 'info' },
  'node.completed': { label: { zh: '节点完成', en: 'Node completed' }, tone: 'success' },
  'node.failed': { label: { zh: '节点失败', en: 'Node failed' }, tone: 'danger' },
  'home.run.started': { label: { zh: '运行开始', en: 'Run started' }, tone: 'brand' },
  'home.route.decided': { label: { zh: '路由决策', en: 'Route decided' }, tone: 'info' },
  'home.run.completed': { label: { zh: '运行完成', en: 'Run completed' }, tone: 'success' },
  'home.run.failed': { label: { zh: '运行失败', en: 'Run failed' }, tone: 'danger' },
  'skill.injected': { label: { zh: '注入技能', en: 'Skill injected' }, tone: 'neutral' },
}

export const TONE_COLOR: Record<EventTone, string> = {
  success: 'var(--color-success)',
  danger: 'var(--color-danger)',
  warning: 'var(--color-warning)',
  info: 'var(--color-info)',
  brand: 'var(--color-brand-500)',
  neutral: 'var(--color-fg-2)',
}

// 事件类型前缀（tool / node / home / skill）映射到图标；未知回退 Activity。
export const CATEGORY_ICON: Record<string, LucideIcon> = {
  tool: Wrench,
  node: Cpu,
  home: Home,
  skill: Zap,
}

export function categoryOf(type: string): string {
  return type.split('.')[0] ?? 'event'
}

export function eventIcon(type: string): LucideIcon {
  return CATEGORY_ICON[categoryOf(type)] ?? Activity
}

export function eventTone(type: string): EventTone {
  return EVENT_META[type]?.tone ?? 'neutral'
}

export function eventLabel(type: string, lang: string): string {
  const meta = EVENT_META[type]
  if (meta) return lang.startsWith('en') ? meta.label.en : meta.label.zh
  return humanizeType(type)
}

/** 未知事件类型的人类可读回退（首字母大写、下划线转空格） */
export function humanizeType(type: string): string {
  const tail = type.split('.').pop() ?? type
  return tail.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export interface Fact {
  k: string
  v: string
}

const MAX_FACT_LEN = 80

/** 从事件 payload 抽取扁平关键字段（用于时间线卡片的快速摘要；完整内容走原始 JSON 展开） */
export function factsOf(payload: unknown): Fact[] {
  if (payload === null || payload === undefined) return []
  if (typeof payload !== 'object') return [{ k: 'value', v: String(payload) }]
  const out: Fact[] = []
  for (const [k, val] of Object.entries(payload as Record<string, unknown>)) {
    if (k === '__raw') continue
    out.push({ k, v: truncate(formatPrimitive(val), MAX_FACT_LEN) })
  }
  return out
}

function formatPrimitive(v: unknown): string {
  if (v === null) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return `[${v.length}]`
  if (typeof v === 'object') return '{…}'
  return String(v)
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/** 毫秒耗时 → 紧凑展示（<1s 用 ms；<1min 用 s；否则 m s） */
export function formatDuration(ms: number | null): string {
  if (ms === null || Number.isNaN(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rs = Math.round(s % 60)
  return `${m}m${rs}s`
}
