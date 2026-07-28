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

// ============================================================================
// LLM 契约（§5.3 + §三之三 I）—— 主进程 client/agent 用，部分经流式事件到渲染层
// ============================================================================

/** LLM 消息角色（Anthropic 原生 role 子集；system 抽顶层不进 messages，铁律9） */
export type LlmRole = 'user' | 'assistant'

/** LLM 消息内容块（与 Anthropic content block 对齐） */
export type LlmContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result'
      tool_use_id: string
      content: string
      is_error?: boolean
    }

export interface LlmMessage {
  role: LlmRole
  content: string | LlmContentBlock[]
}

/** 流式增量（client.stream 产出，agent 聚合成 StreamEvent 推渲染层） */
export type LlmDelta =
  | { type: 'text'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; partial_json: string }
  | { type: 'tool_use_stop'; id: string }
  | { type: 'message_stop'; stop_reason: string | null }
  | { type: 'error'; error: string }

/** Agent 运行请求（铁律9：maxTokens 从 defaultOptions 取） */
export interface LlmRequest {
  model: string
  system?: string
  messages: LlmMessage[]
  /** 工具定义（显式 JSON Schema，§J） */
  tools?: LlmToolDef[]
  maxTokens: number // 必传，Anthropic 强制；缺省 16384（铁律8）
  temperature?: number
  /** 流式增量回调 */
  onDelta?: (delta: LlmDelta) => void
  signal?: AbortSignal
}

export interface LlmToolDef {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

/** Agent 一轮响应（tool_use 循环判定依据） */
export interface LlmResponse {
  stopReason: string | null
  /** assistant 产出的内容块 */
  content: LlmContentBlock[]
}


// ============================================================================
// 存储实体契约（§5.2 + §四迁移映射）—— 主/渲染唯一契约源
// 配置类（capability/agent/skill/model/persona）存 JSON 文件；
// 会话/任务/记忆存 SQLite（见 storage/db.ts schema）。
// ============================================================================

/** 模型配置（原 models.json → userData/models.json） */
export interface ModelConfig {
  id: string
  /** 模型标识，如 claude-sonnet-5 */
  modelId: string
  /** 显示名 */
  name: string
  /** 中转/官方 endpoint；空走官方 */
  baseUrl?: string
  /** 关联 vault 里的 key id（不裸持明文） */
  keyId?: string
  /** 是否默认模型 */
  isDefault?: boolean
  /** max_tokens 缺省（铁律8：缺省 16384） */
  maxTokens?: number
  temperature?: number
  createdAt: number
  updatedAt: number
}

/** 角色（可编排的多个 agent 单元） */
export interface Agent {
  id: string
  name: string
  description?: string
  /** system prompt */
  instructions: string
  /** 绑定的技能 id 列表 */
  skillIds?: string[]
  /** 默认模型 id */
  modelId?: string
  temperature?: number
  maxTokens?: number
  /** 输出约束（"≤N字"等） */
  outputConstraints?: string
  source?: 'builtin' | 'custom'
  createdAt: number
  updatedAt: number
}

/** 技能（ContextProvider，§铁律22） */
export interface Skill {
  id: string
  name: string
  description?: string
  /** SKILL.md 内容（inline 成 <skill> XML 块，限长 24000 字） */
  content: string
  /** 输出纪律段 */
  discipline?: string
  /** 脚本路径（async 执行，§铁律23） */
  scriptPath?: string
  createdAt: number
  updatedAt: number
}

/** 能力（编排图，对应 WorkflowGraph 持久化） */
export interface Capability {
  id: string
  name: string
  description?: string
  graph: WorkflowGraph
  createdAt: number
  updatedAt: number
}

/** 首页主助手人设（独立于角色，固定人格） */
export interface Persona {
  id: string // 固定 'home'
  name: string
  instructions: string
  modelId?: string
  /** L0 个人档案（称呼/角色/偏好语种） */
  profile?: {
    alias?: string
    role?: string
    preferredLanguage?: 'zh-CN' | 'en'
  }
  updatedAt: number
}

/** 会话（SQLite） */
export interface Session {
  id: string
  userId: string // 默认 'local'，不做隔离（§5.2.2）
  title: string
  capabilityId?: string
  createdAt: number
  updatedAt: number
}

/** 消息（SQLite） */
export interface SessionMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  meta?: unknown
  createdAt: number
}

/** 任务历史（SQLite） */
export interface TaskRecord {
  id: string
  userId: string
  sessionId?: string
  capabilityId?: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
  graph?: WorkflowGraph
  result?: unknown
  error?: string
  createdAt: number
  updatedAt: number
}

/** LLM key 配置（经 vault 加密存盘，渲染层只见 keyId） */
export interface LLMConfig {
  baseUrl?: string
  apiKey?: string // 经主进程加密存盘；getLLMConfig 解密返回
  defaultModel?: string
}



// ============================================================================
// Agent 执行单元契约（§5.1.4 + §三之三 D + 铁律6/8）——
// Agent 管 context，tool-use 循环借力 SDK（铁律6）；maxTokens 从 defaultOptions 取（铁律8）
// ============================================================================

/** Agent 默认选项（对应原框架 default_options，max_tokens 只从这里读，铁律8） */
export interface AgentDefaultOptions {
  maxTokens: number // 缺省 16384，防 Anthropic 默认 1024 硬截断
  temperature?: number
}

export interface AgentConfig {
  /** name 三合一：executor_id == agent name == ReactFlow 节点 id（铁律20） */
  name: string
  description?: string
  instructions: string // system prompt（含 L0 身份块 / skill / 约束，§D 拼装顺序）
  modelId: string
  tools?: LlmToolDef[]
  /** 工具名列表（运行时从 registry 取） */
  toolNames?: string[]
  defaultOptions: AgentDefaultOptions // 铁律8
}

export interface AgentRunInput {
  /** 已有 messages（多轮续写） */
  messages: LlmMessage[]
  runId?: string
  signal?: AbortSignal
}

/** Agent 流式回调 */
export interface AgentRunCallbacks {
  onText?: (text: string) => void
  onToolCall?: (tool: string, args: unknown) => void
  onToolResult?: (tool: string, result: unknown) => void
}

/** Agent 终止条件（§D） */
export interface AgentLimits {
  maxIterations?: number // tool-use 循环最大轮数，默认 10
  maxFunctionCalls?: number // 总工具调用预算
}
