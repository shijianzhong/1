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
  /** i18n key（规范：`errors:home.no_provider`）；渲染层优先用此 key 做 t() 查询，无则降级到 message */
  messageKey?: string
}

export type IpcSuccess<T> = { ok: true; data: T }
export type IpcFailure = { ok: false } & IpcError
export type IpcResult<T> = IpcSuccess<T> | IpcFailure

export function ok<T>(data: T): IpcSuccess<T> {
  return { ok: true, data }
}

/**
 * 把历史点号写法 `errors.foo.bar` 归一成 i18next 的 `errors:foo.bar`。
 * 已含 `:` 的 key 原样返回；工具 JSON 里仍可能是点号，渲染层统一过此函数。
 */
export function normalizeI18nKey(messageKey: string): string {
  if (!messageKey || messageKey.includes(':')) return messageKey
  const knownNs = ['errors', 'home', 'common', 'editor', 'settings', 'registry', 'mcp']
  for (const ns of knownNs) {
    if (messageKey === ns) return `${ns}:`
    if (messageKey.startsWith(`${ns}.`)) return `${ns}:${messageKey.slice(ns.length + 1)}`
  }
  return messageKey
}

export function err(code: string, message: string, retryable = false, messageKey?: string): IpcFailure {
  return {
    ok: false,
    code,
    message,
    retryable,
    ...(messageKey ? { messageKey: normalizeI18nKey(messageKey) } : {}),
  }
}

/** 带 messageKey 的错误类，供主进程 throw 使用（withHandler 会提取 messageKey） */
export class IpcErrorThrow extends Error {
  public readonly messageKey: string
  constructor(messageKey: string, message?: string) {
    const key = normalizeI18nKey(messageKey)
    // 可读 fallback：有显式 message 用它；否则至少不是裸 key（渲染层再 t()）
    super(message ?? key)
    this.messageKey = key
    this.name = 'IpcErrorThrow'
  }
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
// 图/事件契约源；orchestrator builder/runner 与渲染层均从此 import（M4 骨架已落地，保真见 task.md）。
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
  | { type: 'output'; node_id: string; speaker: string; text: string; final?: boolean }
  | { type: 'thinking'; node_id: string; speaker: string; text: string }
  | { type: 'tool_call'; node_id: string; tool: string; args: unknown }
  | { type: 'tool_result'; node_id: string; result: unknown }
  | { type: 'handoff'; from: string; to: string }
  | { type: 'failed'; error: string }
  | { type: 'done' }
  // —— HITL 人机交互（ask_user 工具桥，对照原框架 request_info）——
  // request_info：编排内 agent 向用户提问，工作流挂起等待；渲染层渲染提问卡。
  | { type: 'request_info'; request_id: string; node_id: string; question: string; context?: string }
  // request_resolved：用户已作答（response 非空）或提问失效（response 空 = 超时/取消），卡片定格。
  | { type: 'request_resolved'; request_id: string; node_id: string; response: string }
  // —— HITL 工具审批桥（approvalMode='always' → executeTool 闸门 → onApprove）——
  // approval_request：工具执行前请求用户确认，展示工具名 + 完整入参；渲染层弹审批卡。
  | { type: 'approval_request'; request_id: string; node_id: string; tool_name: string; args: unknown }
  // approval_resolved：approved=仅本次 / approved_session=本会话放行 / denied=拒绝；空 = 超时/取消。
  | { type: 'approval_resolved'; request_id: string; node_id: string; response: string }
  // update_plan 计划更新（Task 6）：agent 拆解/推进任务时推渲染层展示
  | { type: 'plan_update'; node_id: string; explanation?: string; plan: Array<{ step: string; status: string }> }

export interface RunResult {
  runId: string
  /** terminal 输出文本（聚合） */
  output: string
}

// ============================================================================
// Pregel 运行时契约（§三 D + §三之三 E + 铁律7/15）——
// Executor = workflow 节点；should_respond 双语义（true run / false 仅 extend cache）；
// 消息 N emit / N+1 deliver；同 superstep 内所有收到消息的 executor 并发。
// ============================================================================

/** Executor cache 中的消息（含 author 用于 GroupChat 发言者识别） */
export interface OrchMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  author?: string // executor_id（GroupChat 发言者/Sequential 上游标识）
  content: string
  /** 关联的 tool_use id（tool_result 配对用，铁律18） */
  toolUseId?: string
  /** 是否为 function_result（孤儿 tool_use 修复用，§K#1） */
  isFunctionResult?: boolean
  /** 投递时是否触发 handle（false=仅 extend cache，broadcast 模式，铁律15） */
  shouldRespond?: boolean
  /** C1：tool_use 占位时存工具名，assembleMessages 据此重建真 tool_use block */
  toolUseName?: string
  /** C1：tool_use 占位时存入参，assembleMessages 据此重建真 tool_use block */
  toolUseInput?: unknown
}

/** Executor 请求（铁律15：should_respond 双语义） */
export interface ExecutorRequest {
  /** 待投递到本 executor cache 的消息 */
  messages: OrchMessage[]
  /** true=触发 run，false=仅 extend cache（broadcast 模式，§三 D） */
  shouldRespond: boolean
}

/** 消息投递信封（runner 内部，N emit / N+1 deliver） */
export interface MessageEnvelope {
  source: string | null // null = 初始输入
  target: string // executor_id
  message: OrchMessage
  /** 是否定向（true=只投 target，false=fan-out 给所有下游） */
  targeted: boolean
}

/**
 * WorkflowContext（Pregel 运行时，§三 D）。
 * Executor 通过它与 runner 交互：发消息、产出输出、发自定义事件。
 */
export interface WorkflowContext {
  send_message(data: unknown, target_id?: string): Promise<void>
  yield_output(data: unknown): Promise<void>
  add_event(e: StreamEvent): Promise<void>
  get_source_executor_id(): string
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
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'image'; mediaType: string; data: string }

/** 用户附件（聊天输入框 + 号选择） */
export interface Attachment {
  id: string
  type: 'image' | 'file' | 'folder'
  name: string
  path: string
  size: number
  /** 图片 base64（data URL，前端预览用） */
  dataUrl?: string
  /** 文本文件内容（file 类型，限制 100KB） */
  textContent?: string
  /** 文件夹目录树摘要（folder 类型） */
  treeSummary?: string
  /** 图片 base64 数据（不含 data: 前缀，发 LLM 用） */
  base64Data?: string
  mediaType?: string
}

export interface LlmMessage {
  role: LlmRole
  content: string | LlmContentBlock[]
}

/** 流式增量（client.stream 产出，agent 聚合成 StreamEvent 推渲染层） */
export type LlmDelta =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; partial_json: string }
  | { type: 'tool_use_stop'; id: string }
  | { type: 'message_stop'; stop_reason: string | null; usage?: TokenUsage }
  | { type: 'error'; error: string }
  | { type: 'retry'; attempt: number; maxRetries: number; delayMs: number; reason: string }

/** LLM token 用量（message_stop 携带，后端不传则 undefined） */
export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

/** 首页流式事件（home:stream）——LlmDelta 超集 + 编排事件 + 会话 id + 创建提案 */
export type HomeStreamEvent = (
  | LlmDelta
  | { type: 'run_id'; sessionId: string }
  | { type: 'orch_event'; event: StreamEvent }
  | { type: 'proposal'; draft: CreateDraft }
  /** propose_* 校验/执行失败 → 前端失败卡（用户可见，可重试） */
  | {
      type: 'proposal_error'
      kind: CreateDraft['kind']
      error: string
      messageKey?: string
      detail?: unknown
    }
  /** 创建链路系统提示（补跑中/补跑失败等）；渲染层按 messageKey 翻译 */
  | {
      type: 'create_notice'
      messageKey: string
      params?: Record<string, string>
      level?: 'info' | 'warn' | 'error'
    }
 ) & {
  /** 首页运行所属会话；前端按会话路由流式态，避免切会话串流 */
  sessionId?: string
}

/** 重试回调参数 */
export interface RetryInfo {
  attempt: number
  maxRetries: number
  delayMs: number
  reason: string
}

/** thinking 配置（extended thinking） */
export interface ThinkingConfig {
  type: 'enabled' | 'adaptive' | 'disabled'
  /** enabled 模式下的思考预算 token（≥1024，< maxTokens） */
  budgetTokens?: number
}

/** Agent 运行请求（铁律9：maxTokens 从 defaultOptions 取） */
export interface LlmRequest {
  model: string
  system?: string
  messages: LlmMessage[]
  /** 工具定义（显式 JSON Schema，§J） */
  tools?: LlmToolDef[]
  maxTokens: number // 必传，Anthropic 强制；缺省 16384（铁律8）
  temperature?: number
  /** thinking 配置（推理模型用） */
  thinking?: ThinkingConfig
  /** 流式增量回调 */
  onDelta?: (delta: LlmDelta) => void
  /** 重试等待回调（429/5xx 等，通知前端「重试中」） */
  onRetry?: (info: RetryInfo) => void
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
  /** 关联的 provider（baseUrl + key 在 provider 级共享）；旧数据可能为空 */
  providerId?: string
  /** 中转/官方 endpoint（旧字段，迁移期保留；新数据走 providerId） */
  baseUrl?: string
  /** vault key id（旧字段，迁移期保留；新数据走 provider.keyId） */
  keyId?: string
  /** 是否默认模型 */
  isDefault?: boolean
  /** 用途标签（思考/知识库/快答/...），agent 可按用途选模型 */
  tags?: string[]
  /** max_tokens 缺省（铁律8：缺省 16384） */
  maxTokens?: number
  temperature?: number
  createdAt: number
  updatedAt: number
}

/** API 协议格式（决定请求拼装 + 认证头） */
export type ApiFormat = 'anthropic' | 'openai' | 'custom'

/** 供应商内嵌的用途模型（cc switch 范式：一个供应商配多个用途模型） */
export interface ProviderModels {
  /** 主模型 modelId */
  primary?: string
  /** 推理模型 modelId（带 thinking） */
  reasoning?: string
  /** 快答模型 modelId */
  fast?: string
  /** 默认模型 modelId（未指定用途时用） */
  default?: string
}

/**
 * 供应商（cc switch 范式：以供应商为中心）。
 * 一个供应商 = baseUrl + key + apiFormat + 认证 + 多个用途模型。
 */
export interface Provider {
  id: string
  /** 显示名，如 Anthropic / 本地中转 */
  name: string
  /** 备注 */
  remark?: string
  /** 官网 */
  website?: string
  /** 请求地址（中转/官方 endpoint）；空走官方 */
  baseUrl?: string
  /** API 协议格式 */
  apiFormat: ApiFormat
  /** 认证头字段名（如 Authorization / x-api-key），默认按 apiFormat 推断 */
  authHeader?: string
  /** vault key id（key 在 provider 级共享） */
  keyId?: string
  /** 用途模型（主/推理/快答/默认） */
  models: ProviderModels
  /** 是否开启 thinking（供应商级开关，用户决定中转是否支持） */
  enableThinking?: boolean
  /** 是否默认供应商（聊天/编排默认使用） */
  isDefault?: boolean
  createdAt: number
  updatedAt: number
}

/**
 * 按用途从供应商解析出 modelId（agent 选模型用）。
 * @param usage primary/reasoning/fast/default；default 兜底
 */
export function resolveModelIdByUsage(
  provider: Pick<Provider, 'models'>,
  usage: keyof ProviderModels = 'default',
): string | undefined {
  const m = provider.models
  return m[usage] ?? m.default ?? m.primary ?? m.reasoning ?? m.fast
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
  /**
   * 资产级工具白名单（PROJECT_REVIEW P1）。
   * undefined / 空 = 不限制（沿用运行时工具快照）；非空 = 仅暴露列出的工具名。
   */
  allowedToolNames?: string[]
  /** 默认模型 id */
  modelId?: string
  temperature?: number
  maxTokens?: number
  /** 输出约束（"≤N字"等） */
  outputConstraints?: string
  source?: 'builtin' | 'custom'
  /** registry 溯源（导入/发布过才有；纯本地创建无此字段） */
  registry?: RegistryProvenance
  createdAt: number
  updatedAt: number
}

/** 技能（ContextProvider，§铁律22）
 *  目录化存储（docs/SKILL_STORAGE_STANDARD_PLAN.md）：磁盘事实为 config/skills/<id>/SKILL.md。
 *  hasScripts 从目录扫描得出（运行时投影），不持久化到 SKILL.md。 */
export interface Skill {
  id: string
  name: string
  description?: string
  /** 检索标签（frontmatter tags） */
  tags?: string[]
  /** SKILL.md 内容（inline 成 <skill> XML 块，限长 24000 字） */
  content: string
  /** 输出纪律段 */
  discipline?: string
  /** 含 scripts/ 子目录且非空（运行时扫描得出，非持久化字段） */
  hasScripts?: boolean
  /** registry 溯源 */
  registry?: RegistryProvenance
  createdAt: number
  updatedAt: number
}

/** Skill 轻量元数据（不含 content，用于列表展示和 mention 解析） */
export type SkillMeta = Omit<Skill, 'content'> & { contentLength: number }

/** 能力（编排图，对应 WorkflowGraph 持久化） */
export interface Capability {
  id: string
  name: string
  description?: string
  graph: WorkflowGraph
  /**
   * 能力级工具白名单（作用于该能力图内节点）。
   * undefined / 空 = 不限制。
   */
  allowedToolNames?: string[]
  /** registry 溯源 */
  registry?: RegistryProvenance
  createdAt: number
  updatedAt: number
}

// ============================================================================
// Registry 共享契约（docs/REGISTRY_PLAN.md §1/§2）——
// 本地 id（agt_/skl_/cap_）与 registry slug 是两个命名空间，provenance 做桥接。
// ============================================================================

/** 资产来源溯源（registry 导入/发布过才有；纯本地创建无此字段） */
export interface RegistryProvenance {
  /** registry slug，如 "code-reviewer" */
  registryId: string
  /** 导入/发布时 manifest 的 version */
  version: string
  author?: string
  importedAt: number
}

export type RegistryAssetKind = 'agent' | 'skill' | 'capability'

/** index.json 条目（列表页用；version 供更新检测，勿省） */
export interface RegistryIndexEntry {
  id: string
  name: string
  description?: string
  author?: string
  version?: string
  tags?: string[]
  /** skill 条目：含 scripts/ 时 true（导入确认框据此提示） */
  hasScripts?: boolean
  /** skill 条目：含纪律定义时 true */
  hasDiscipline?: boolean
  updatedAt?: string
}

/** index.json 全局索引（CI 生成，贡献者不手改） */
export interface RegistryIndex {
  version: number
  updated?: string
  agents: RegistryIndexEntry[]
  skills: RegistryIndexEntry[]
  capabilities: RegistryIndexEntry[]
}

/** Agent manifest（registry 侧；skillIds 是 slug，modelHint 仅展示） */
export interface RegistryAgentManifest {
  id: string
  name: string
  description?: string
  author?: string
  version: string
  tags?: string[]
  instructions: string
  /** registry slug 列表，导入时重映射为本地 id */
  skillIds?: string[]
  /** 导出时取本地 ModelConfig 真实模型名，仅供详情页展示；导入不设 modelId */
  modelHint?: string
  temperature?: number
  maxTokens?: number
  outputConstraints?: string
  updatedAt?: string
}

/** Skill manifest（registry 侧） */
export interface RegistrySkillManifest {
  id: string
  name: string
  description?: string
  author?: string
  version: string
  tags?: string[]
  skillZip: string
  hasScripts?: boolean
  hasDiscipline?: boolean
  updatedAt?: string
}

/** Capability manifest（registry 侧；图节点内联快照，skillIds/sourceAgentId 为 slug） */
export interface RegistryCapabilityManifest {
  id: string
  name: string
  description?: string
  author?: string
  version: string
  tags?: string[]
  graph: WorkflowGraph
  dependencies?: {
    agents?: string[]
    skills?: string[]
  }
  updatedAt?: string
}

/** Registry 源（urlTemplate 含 {repo}/{ref}/{path} 占位，多源 fallback） */
export interface RegistrySource {
  id: string
  urlTemplate: string
}

/** GitHub Token 在 vault 中的 keyId（设置页写入；主进程数据层读到即附带，明文不出主进程） */
export const REGISTRY_TOKEN_KEY_ID = 'registry_github_token'

/** 默认镜像源（设置页「重置为默认」与主进程缺省配置共用，§4.1） */
export const DEFAULT_REGISTRY_SOURCES: RegistrySource[] = [
  { id: 'github-raw', urlTemplate: 'https://raw.githubusercontent.com/{repo}/{ref}/{path}' },
  { id: 'jsdelivr', urlTemplate: 'https://cdn.jsdelivr.net/gh/{repo}@{ref}/{path}' },
]

/** registry.json 本地配置（userData/config/registry.json；设置页 Phase 4 接管） */
export interface RegistryConfig {
  /** "owner/name" */
  repo: string
  /** 分支/ref，默认 main */
  ref: string
  sources: RegistrySource[]
}

/** 导入计划条目（planImport 返回，确认框展示） */
export interface RegistryImportPlanItem {
  kind: RegistryAssetKind
  slug: string
  name: string
  /** new=新装 / update=覆盖更新（保留本地 id）/ installed=同版本跳过 */
  status: 'new' | 'update' | 'installed'
  /** skill 含脚本时列出脚本相对路径（确认框警告用） */
  scripts?: string[]
}

export interface RegistryImportPlan {
  items: RegistryImportPlanItem[]
  hasScripts: boolean
}

/** 导入结果汇总（applyImport 返回） */
export interface RegistryImportResult {
  imported: Array<{ kind: RegistryAssetKind; slug: string; localId: string; name: string }>
  skipped: Array<{
    kind: RegistryAssetKind
    slug: string
    name: string
    /** installed=同版本已安装；locally_modified=导入后本地改过，默认跳过防覆盖（§2.3）；failed=预留 */
    reason?: 'installed' | 'locally_modified' | 'failed'
  }>
  /** 图重映射时被剔除的 skill slug（registry 缺失/未勾选） */
  droppedSkillSlugs?: string[]
}

// —— 导出（§3.3 级联推送：planExport 预览 → 用户编辑 slug/version + 勾选 → applyExport 落盘 + provenance 回写）——

/** 导出预览条目（slug/version 预填，渲染层可编辑后随确认回传） */
export interface RegistryExportPlanItem {
  kind: RegistryAssetKind
  localId: string
  name: string
  /** 预填 slug：provenance.registryId 或名称 slug 化（非法字符兜底随机后缀） */
  slug: string
  /** 预填版本：有 provenance 则 bump patch，否则 1.0.0 */
  version: string
  /** 有 provenance → update（覆盖同 slug 远程条目），否则 new */
  status: 'new' | 'update'
  /** 级联自动附带（非用户点选的主资产） */
  auto?: boolean
}

/** 导出预览（planExport 返回） */
export interface RegistryExportPlan {
  items: RegistryExportPlanItem[]
  /** dangling 引用等告警（被引资产本地不存在，序列化时剔除） */
  warnings: string[]
}

/** 导出确认项（用户勾选 + 编辑 slug/version 后回传 applyExport；未勾选的依赖不进序列化，图引用剔除） */
export interface RegistryExportConfirmItem {
  kind: RegistryAssetKind
  localId: string
  slug: string
  version: string
}

/** 导出结果（applyExport 返回；null = 用户取消目录选择） */
export interface RegistryExportResult {
  /** 落盘根目录（所选目录下的 one-registry-export/） */
  dir: string
  /** 写入的文件相对路径清单 */
  files: string[]
}

// ============================================================================
// 聊天创建（主 Agent 经 propose_* 工具产出草稿 → 前端确认卡 → 用户确认入库）
// 草稿先落 userData/drafts/create-*.json（崩溃可水合）；用户确认后才经 home:confirmCreate 入库。
// ============================================================================

/** 创建提案草稿（前端确认卡数据源；payload 即对应类型的可入库字段） */
export type CreateDraft = {
  draftId: string
  /** 所属聊天会话；回合结束后按 session 重挂未确认卡，避免被 streamMsgs 清空吞掉 */
  sessionId?: string
} & (
  | {
      kind: 'agent'
      payload: {
        name: string
        description?: string
        instructions: string
        outputConstraints?: string
        temperature?: number
        maxTokens?: number
      }
    }
  | {
      kind: 'capability'
      payload: { name: string; description?: string; graph: WorkflowGraph }
    }
  | {
      kind: 'skill'
      payload: { name: string; description?: string; content: string; discipline?: string }
    }
  | {
      kind: 'persona'
      /** 人设更新：instructions 为新的人设正文（全量替换）；不传 = 保留当前人设（仅改档案） */
      payload: {
        instructions?: string
        /** 可选：同时更新 profile（alias/role/language），未传则保留原值 */
        profile?: {
          alias?: string
          role?: string
          preferredLanguage?: 'zh-CN' | 'en'
        }
      }
    }
)

/** 聊天创建状态（assistant 消息 meta.create；事实源，非模型正文） */
export type CreateMetaStatus = 'proposed' | 'confirmed' | 'failed' | 'hallucination_recovered'

export interface CreateMeta {
  status: CreateMetaStatus
  kind?: CreateDraft['kind']
  draftId?: string
}

/** 首页主助手人设（独立于角色，固定人格） */
export interface Persona {
  id: string // 固定 'home'
  name: string
  instructions: string
  modelId?: string
  /** 绑定的技能 id 列表（首页主助手也可注入 skill，§铁律22） */
  skillIds?: string[]
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
  /** 项目根绝对路径（agent 文件工具 + shell 默认 cwd；可为空=无项目上下文） */
  cwd?: string
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
  /** 输出约束（"≤N字"等，§D 拼装顺序第 4 步） */
  outputConstraints?: string
  /** thinking 配置（推理模型用，undefined=不开） */
  thinking?: ThinkingConfig
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
  onThinking?: (text: string) => void
  onToolCall?: (tool: string, args: unknown, toolUseId: string) => void
  onToolResult?: (tool: string, result: unknown, toolUseId: string) => void
  onRetry?: (info: RetryInfo) => void
  /** message_stop：LLM 回合结束，携带 token 用量（后端不传则 undefined） */
  onMessageStop?: (usage?: TokenUsage) => void
}

/** Agent 终止条件（§D） */
export interface AgentLimits {
  /** tool-use 循环最大轮数，默认 32；触顶后强制一轮无工具收尾 */
  maxIterations?: number
  maxFunctionCalls?: number // 总工具调用预算
}


// ============================================================================
// 三级记忆实体契约（§5.2.2 + §三之三 D + 铁律21）——
// L1 会话内摘要存 SQLite memory_l1；L2 跨会话摘要存 memory_l2；
// L3 长期沉淀存 memory_l3，走 memory_recall/memory_search 工具按需检索（不硬塞 prompt）。
// 不做用户隔离：user_id 默认 'local'（§5.2.2）。
// ============================================================================

/** L1 会话内滚动摘要（单会话级，存 SQLite） */
export interface L1Summary {
  sessionId: string
  summary: string
  /** 已压缩到哪条消息 id（下次只压 summarizedUpTo 之后） */
  summarizedUpTo?: string
  ts: number
}

/** L2 跨会话摘要（注入 persona，限长 1500 字） */
export interface L2Digest {
  userId: string
  sessionId?: string
  digest: string
  ts: number
}

/** L3 长期沉淀（key-value，按需检索） */
export interface L3Fact {
  userId: string
  key: string
  value: string
  ts: number
}

// ============================================================================
// 内容生产知识资产（docs/CONTENT_PIPELINE_PLAN.md §2.3）——
// 选题库 TopicLibrary（SQLite）/ Review 档案（SQLite）/
// 风格画像 StyleProfile（JsonCollection）/ 样文 SampleArticle（目录化）。
// builtin 基线经 §2.5 seedBuiltinAssets 复制进 userData，用户可改可分享。
// ============================================================================

/** 选题状态 */
export type TopicStatus = 'pending' | 'researching' | 'producing' | 'published' | 'archived'

/** 选题推荐度（1-3 个圆点） */
export type TopicRecommendation = 1 | 2 | 3

/** 选题库条目（SQLite topics 表，v7 迁移） */
export interface Topic {
  id: string
  userId: string // 默认 'local'，不做隔离
  /** 选题标题/切口 */
  title: string
  /** 方向（AI 全谱 / 前端工程 / 程序员职场副业 / 自定义） */
  direction?: string
  status: TopicStatus
  /** 推荐度 1-3 */
  recommendation?: TopicRecommendation
  /** 选题价值评估（热度信号/搜索价值/对标空白/判断结论），JSON */
  meta?: TopicMeta
  /** 标签 */
  tags?: string[]
  createdAt: number
  updatedAt: number
}

/** 选题价值评估细节（存 topics.meta JSON 列） */
export interface TopicMeta {
  /** 热度信号 */
  heatSignal?: string
  /** 搜索价值 */
  searchValue?: string
  /** 对标空白 */
  benchmarkGap?: string
  /** 判断结论（可行/需调角度/否决 + 理由） */
  verdict?: string
  /** 推荐切口 */
  angle?: string
  /** 备选切口 */
  altAngles?: string[]
  /** 三维过筛结论 */
  triFilter?: {
    heat?: boolean
    redSea?: boolean
    blank?: boolean
  }
}

/** Review 档案条目（SQLite reviews 表，v8 迁移） */
export interface ReviewRecord {
  id: string
  userId: string // 默认 'local'
  /** 被审资产类型（article / topic / agent / capability） */
  assetType: string
  /** 被审资产 id（选题 id / 文章 slug / agent id） */
  assetId: string
  /** 爆款总分 0-10 */
  score: number
  /** 结论：可发/需返工/推倒重写 */
  verdict: '可发' | '需返工' | '推倒重写'
  /** review 详情（5 维打分 + 对标对比 + 改点清单 + AI腔命中），JSON */
  notes?: ReviewNotes
  createdAt: number
}

/** Review 详情（存 reviews.notes JSON 列） */
export interface ReviewNotes {
  /** 5 维爆款打分 */
  dimensions?: {
    title?: number // 0-2
    opening?: number
    punchline?: number
    authenticity?: number
    interaction?: number
  }
  /** 总分 */
  total?: number
  /** 对标账号差距 */
  benchmark?: string
  /** 具体改点清单（按优先级） */
  revisionPoints?: string[]
  /** AI腔逐句诊断命中（§2.5 两类根源） */
  aiCavityHits?: AiCavityHit[]
  /** 发布前微调建议 */
  finalTweaks?: string[]
}

/** AI腔逐句诊断命中项（ai_cavity_audit 工具产出 + A6 reviewer 核定） */
export interface AiCavityHit {
  /** 原句 */
  sentence: string
  /** 根源类型 */
  type: 'self_invented_term' | 'english_connection_misuse'
  /** 命中词/位置 */
  marker?: string
  /** 改写建议 */
  suggestion?: string
}

/** 风格画像（JsonCollection，config/style-profiles/{id}.json） */
export interface StyleProfile {
  id: string
  /** 画像名（如"本号固化风格"） */
  name: string
  description?: string
  /** 标题公式列表 */
  titleFormulas?: string[]
  /** 6 段式骨架 */
  structureSkeleton?: string
  /** 语气词表 */
  toneWords?: string[]
  /** 字数区间 */
  wordCountRange?: string
  /** 互动钩子模板 */
  interactionHooks?: string[]
  /** 自造说法禁用清单（吸收 Roland 判据） */
  bannedInventedTerms?: string[]
  /** 英译式连接词禁用清单（反映出/体现出/表明了 等） */
  bannedEnglishConnections?: string[]
  createdAt: number
  updatedAt: number
}

/** 样文（目录化，config/sample-articles/<id>/ARTICLE.md + references/） */
export interface SampleArticle {
  id: string
  /** 显示名 */
  name: string
  description?: string
  /** 正文（ARTICLE.md 内容） */
  content: string
  /** 来源号（如码农翻身/量子位） */
  source?: string
  /** 标签 */
  tags?: string[]
  /** 是否含 references/ 子目录 */
  hasReferences?: boolean
  /** 文章字数 */
  wordCount?: number
  createdAt: number
  updatedAt: number
}

/** memory_recall/memory_search 工具入参 */
export interface MemoryRecallInput {
  query: string
  limit?: number
}

/** memory_retain 工具入参（写入 L3） */
export interface MemoryRetainInput {
  key: string
  value: string
}


// ============================================================================
// 编排模式配置（§三之三 B + §三 D）—— GroupChat/Handoff/Magentic
// ============================================================================

/** GroupChat 发言者选择模式 */
export type GroupChatSelectorMode = 'round_robin' | 'manager'

/** GroupChat 容器配置 */
export interface GroupChatConfig {
  participants: string[]
  selectorMode: GroupChatSelectorMode
  maxRounds: number // 默认 6
}

/** Handoff 边（§三之三 B） */
export interface HandoffEdge {
  source: string
  targets: string[]
}

/** Handoff 容器配置 */
export interface HandoffConfig {
  participants: string[]
  handoffs: HandoffEdge[]
  startAgent: string
}

/** Magentic 配置（MVP 跳过） */
export interface MagenticConfig {
  manager: string
  workers: string[]
}

/**
 * GroupChat manager 结构化输出（§三之三 G + 铁律19）。
 * 走 response_format 结构化输出。
 */
export interface AgentOrchestrationOutput {
  terminate: boolean
  reason: string
  next_speaker: string
  final_message: string
}

// —— MCP（Model Context Protocol）服务器配置与状态 ——
export type McpTransportType = 'stdio' | 'http'

export interface McpServerConfig {
  id: string
  name: string
  transport: McpTransportType
  /** stdio: 可执行文件路径 */
  command?: string
  /** stdio: 命令行参数 */
  args?: string[]
  /** stdio: 环境变量（不传则继承安全子集） */
  env?: Record<string, string>
  /** stdio: 工作目录 */
  cwd?: string
  /** http: 服务器 URL */
  url?: string
  /** http: 自定义请求头 */
  headers?: Record<string, string>
  /** 启动时自动连接 */
  enabled: boolean
  /** 工具审批模式：always=每次调用需确认（默认），auto=自动执行 */
  approvalMode?: 'always' | 'auto'
  /**
   * 显式注入：为 true 且已连接时，该 server 的 mcp__* 工具才会进入首页/编排 agent 的工具列表。
   * 默认 false——连接 ≠ 自动暴露给 LLM（C1/R2）。
   */
  exposeToAgents?: boolean
}

export interface McpServerStatus {
  config: McpServerConfig
  connected: boolean
  toolCount: number
  error?: string
  tools?: Array<{ name: string; description?: string }>
}
