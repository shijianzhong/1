export interface ThemeBackgroundConfig {
  type: 'none' | 'image' | 'gradient'
  imageId?: string
  blurPx?: number
  dimAmount?: number
  position?: 'cover' | 'contain' | 'center'
}

export interface ThemeConfig {
  preset: 'pure-white' | 'warm' | 'dark' | 'custom'
  mode: 'system' | 'light' | 'dark'
  accent?: string | null
  bgOverride?: string | null
  fgOverride?: string | null
  glassTint?: 'neutral' | 'warm' | 'cool'
  glassBlur?: number
  glassOpacity?: number
  background?: ThemeBackgroundConfig
  density?: 'comfortable' | 'compact' | 'spacious'
  fontScale?: number
  fontMono?: string
}

export interface SystemPingResponse {
  ok: true
  appVersion: string
  platform: NodeJS.Platform
}

/**
 * IPC 错误统一结构（§11.3）
 * 所有 ipcMain.handle 经 withHandler 包装后，失败返回 { ok:false, ...IpcError }，
 * 成功返回 { ok:true, data }。判别联合，渲染层 api/ 据此识别并按 retryable 重试。
 */
export interface IpcError {
  code: string
  message: string
  retryable: boolean
}

export type IpcSuccess<T> = { ok: true; data: T }
export type IpcFailure = { ok: false } & IpcError
export type IpcResult<T> = IpcSuccess<T> | IpcFailure

export function ok<T>(data: T): IpcSuccess<T> {
  return { ok: true, data }
}

export function err(code: string, message: string, retryable = false): IpcFailure {
  return { ok: false, code, message, retryable }
}

export function isIpcFailure<T>(value: IpcResult<T>): value is IpcFailure {
  return typeof value === 'object' && value !== null && value.ok === false
}

export const DEFAULT_THEME: ThemeConfig = {
  preset: 'pure-white',
  mode: 'system',
  accent: '#4ECDC4',
  glassTint: 'cool',
  glassBlur: 16,
  glassOpacity: 0.6,
  background: { type: 'none' },
  density: 'comfortable',
  fontScale: 1,
}

// ============================================================================
// 编排引擎契约（§5.1.3 + §三之三 B/F）—— 主/渲染唯一契约源
// 骨架阶段只放类型；编排引擎阶段（M4）落地 builder/runner 时直接 import。
// ============================================================================

/** 6 种节点类型（§三之三 B） */
export type NodeType =
  | 'agent'
  | 'sequential'
  | 'concurrent'
  | 'groupchat'
  | 'handoff'
  | 'magentic'

export interface GraphNode {
  id: string
  type: NodeType
  data: Record<string, unknown> // 各 kind 特有配置，builder 阶段细化
  position: { x: number; y: number }
}

export interface GraphEdge {
  source: string
  target: string
  /** 条件边谓词，MVP 仅 `contains:<sub>` + 恒真（§三之三 B） */
  condition?: string
}

export interface WorkflowGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/** 编排流式事件（§5.1.3 + §三之三 F）—— 替代原 SSE，主进程 webContents.send → 渲染 ipcRenderer.on */
export type StreamEvent =
  | { type: 'node_started'; node_id: string }
  | { type: 'node_done'; node_id: string }
  | { type: 'node_error'; node_id: string; error: string }
  | { type: 'output'; node_id: string; speaker: string; text: string }
  | { type: 'tool_call'; node_id: string; tool: string; args: unknown }
  | { type: 'tool_result'; node_id: string; result: unknown }
  | { type: 'handoff'; from: string; to: string }
  | { type: 'failed'; error: string }
  | { type: 'done' }

export interface RunResult {
  runId: string
  /** terminal 输出文本（聚合） */
  output: string
}

