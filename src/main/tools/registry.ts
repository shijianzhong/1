import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { LlmToolDef } from '@shared/types'
import { logger } from '../logger'
import { isSessionToolApproved } from './sessionApprovals'

// —— 工具注册表（§三之三 J + 铁律11）——
// registerTool 把普通函数包成 FunctionTool，**必须显式构造 JSON Schema
// 传给 LLM**（否则 LLM 看到无参数工具）。工具调用失败重试 3 次后返回错误
// JSON 不抛异常（抛异常会让 agent 再次调用形成死循环）。

const RETRY_DELAYS_MS = [500, 1000, 1500]

export type ToolApprovalMode = 'auto' | 'always' | 'never'

/**
 * 工具审批决议（HITL 桥返回）。approved=false 时 reason 区分语义，
 * 供 registry 闸门选对应的 i18n key（timeout/aborted/denied），不再合并成单一 denied
 *（CODE_AUDIT 断言 5.5：旧实现 reason 硬编码 'timeout or cancelled' 且 registry 不读 reason，
 *  超时/取消/拒绝全混成 approval_denied，前端无法区分）。
 * 桥（onApprove catch）必发 reason；resolveApprovalDecision 对 denied 也填 reason。
 */
export type ApprovalReason = 'approved' | 'approved_session' | 'timeout' | 'aborted' | 'denied'
export interface ApprovalDecision {
  approved: boolean
  reason?: ApprovalReason
}

/** 审批前硬拦截结果：{ ok: false } 则直接拒绝，不弹审批框 */
export interface PreCheckResult {
  ok: boolean
  error?: string
  messageKey?: string
}

/** registerTool 扩展选项（preCheck + inputSchemaOverride） */
export interface RegisterToolOptions {
  /** 审批前硬拦截（如 shell DANGER_PATTERNS），在 approvalMode 闸门之前执行 */
  preCheck?: (args: unknown) => PreCheckResult
  /** LLM 可见的参数 schema 覆盖（MCP 工具传原始 JSON Schema，绕过 zodToJsonSchema 限制） */
  inputSchemaOverride?: Record<string, unknown>
}

export interface ToolDef extends LlmToolDef {
  approvalMode?: ToolApprovalMode
  /** 审批前硬拦截钩子 */
  preCheck?: (args: unknown) => PreCheckResult
}

export interface ToolContext {
  sessionId?: string
  /** 当前项目根绝对路径——文件工具扩展围栏、shell 默认 cwd 用。无 = 无项目上下文 */
  workspaceRoot?: string
  signal?: AbortSignal
  /** 创建提案回调（propose_* 工具 → home IPC emitStream 桥，由 home.ts 注入） */
  onPropose?: (draft: import('@shared/types').CreateDraft) => void
  /** HITL 提问桥（ask_user 工具 → request_info 事件 + 挂起等待，由编排 IPC 注入）；
   *  未注入 = 当前运行环境不可与用户交互，ask_user 返回 user_input_unavailable */
  onAskUser?: (req: { question: string; context?: string }) => Promise<string>
  /** HITL 工具审批桥（approvalMode='always' → approval_request 事件 + 挂起等待）；
   *  未注入 = 当前运行环境不可审批，always 工具返回 approval_unavailable */
  onApprove?: (req: { toolName: string; args: unknown }) => Promise<ApprovalDecision>
  /** update_plan 计划更新回调（home/orchestrate 注入 → emitStream/emitEvent，渲染层展示计划进度） */
  onPlanUpdate?: (plan: { explanation?: string; plan: Array<{ step: string; status: string }> }) => void
}

export interface ToolResult {
  toolUseId: string
  content: string
  isError: boolean
}

type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<unknown> | unknown

export interface RegisteredTool {
  def: ToolDef
  handler: ToolHandler
  /** 运行时入参校验 schema */
  zodSchema: z.ZodTypeAny
}

const registry = new Map<string, RegisteredTool>()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 注册工具。params 是 Zod schema，运行时校验入参 + 转 JSON Schema 给 LLM。
 * options.preCheck 在 approvalMode 闸门前硬拦截；options.inputSchemaOverride 覆盖 LLM 可见 schema。
 */
export function registerTool(
  name: string,
  description: string,
  params: z.ZodTypeAny,
  handler: ToolHandler,
  approvalMode: ToolApprovalMode = 'auto',
  options?: RegisterToolOptions,
): RegisteredTool {
  const def: ToolDef = {
    name,
    description,
    input_schema: options?.inputSchemaOverride ?? zodToJsonSchema(params),
    approvalMode,
    preCheck: options?.preCheck,
  }
  const entry: RegisteredTool = { def, handler, zodSchema: params }
  // v3：工具名冲突检测——warn 不 throw，避免阻塞启动
  if (registry.has(name)) {
    logger.warn(`[registry] 工具名冲突：${name} 已存在，将被覆盖`)
  }
  registry.set(name, entry)
  return entry
}

/** 执行工具：校验入参 + preCheck 硬拦截 + approvalMode 审批闸门 + 失败重试 3 次后返回错误 JSON 不抛（铁律11） */
export async function executeTool(
  name: string,
  args: unknown,
  toolUseId: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  const entry = registry.get(name)
  if (!entry) {
    return {
      toolUseId,
      content: JSON.stringify({ error: `unknown_tool: ${name}` }),
      isError: true,
    }
  }

  // 入参校验（Zod）
  const r = entry.zodSchema.safeParse(args)
  if (!r.success) {
    return {
      toolUseId,
      content: JSON.stringify({
        error: 'invalid_args',
        detail: r.error.issues,
        ...(name.startsWith('propose_')
          ? { messageKey: 'errors.create.invalid_args' }
          : {}),
      }),
      isError: true,
    }
  }

  // —— 1. preCheck 硬拦截（审批前）—— 避免"用户批准后才拦"的 UX 矛盾
  if (entry.def.preCheck) {
    const check = entry.def.preCheck(r.data)
    if (!check.ok) {
      return {
        toolUseId,
        content: JSON.stringify({
          error: check.error ?? 'precheck_failed',
          messageKey: check.messageKey ?? 'errors.tools.precheck_failed',
        }),
        isError: true,
      }
    }
  }

  // —— 2. approvalMode 闸门 —— 'always' 工具必须经用户确认才能执行
  // 「本会话允许」后同 sessionId + 同工具名跳过弹窗；preCheck 已在上方执行，危险命令仍硬拦。
  if (entry.def.approvalMode === 'always' && !isSessionToolApproved(ctx.sessionId, name)) {
    if (!ctx.onApprove) {
      return {
        toolUseId,
        content: JSON.stringify({
          error: 'approval_unavailable',
          messageKey: 'errors.tools.approval_unavailable',
        }),
        isError: true,
      }
    }
    // 300s 超时 → 视为拒绝（避免用户离开电脑弹窗无限等待）
    const result = await withTimeout(
      ctx.onApprove({ toolName: name, args: r.data }),
      300_000,
    )
    if (result === null) {
      return {
        toolUseId,
        content: JSON.stringify({
          error: 'approval_timeout',
          messageKey: 'errors.tools.approval_timeout',
        }),
        isError: true,
      }
    }
    if (!result.approved) {
      // 按 reason 分流 i18n key：timeout（超时）/ aborted（运行被取消/顶替）/ denied（用户拒绝）
      // 旧实现 reason 硬编码且不读 → 全混 approval_denied，前端无法区分（CODE_AUDIT 断言 5.5）
      const reason = result.reason ?? 'denied'
      const messageKey =
        reason === 'timeout'
          ? 'errors.tools.approval_timeout'
          : reason === 'aborted'
            ? 'errors.tools.approval_aborted'
            : 'errors.tools.approval_denied'
      return {
        toolUseId,
        content: JSON.stringify({
          error: reason === 'timeout' ? 'approval_timeout' : reason === 'aborted' ? 'approval_aborted' : 'approval_denied',
          messageKey,
        }),
        isError: true,
      }
    }
  }

  // —— 3. 正常执行 handler ——
  // approvalMode='always' 的工具不自动重试：用户批准的是一次特定调用，
  // 自动重试会绕过审批闸门执行用户未确认的重复操作（如重复扣款、重复写入）。
  // 其他工具重试 3 次，失败返回错误 JSON 不抛（铁律11）。
  const skipRetry = entry.def.approvalMode === 'always'
  const maxAttempts = skipRetry ? 1 : RETRY_DELAYS_MS.length + 1
  let lastError: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await entry.handler(r.data, ctx)
      const content = typeof result === 'string' ? result : JSON.stringify(result)
      // 工具业务失败（{ ok: false }）→ 标记 is_error=true（协议语义）
      // 让 LLM 明确感知工具失败，而非从 JSON 内容自行推断
      const isError =
        typeof result === 'object' &&
        result !== null &&
        'ok' in result &&
        (result as Record<string, unknown>).ok === false
      return { toolUseId, content, isError }
    } catch (error) {
      lastError = error
      // abort 不重试：运行已被取消（用户停止 / 编排结束 / 超时 abort）时，ctx.signal.aborted=true。
      // 此刻重试只会把已废弃的操作再跑 N 次（带退避延迟），延长取消响应、浪费配额，且 handler
      // 多半仍会再次 abort。立即返回结构化 abort 错误，让 agent loop 尽快收尾。
      if (ctx.signal?.aborted) {
        logger.info(`[tool:${name}] 执行被 abort 取消，跳过重试`)
        return {
          toolUseId,
          content: JSON.stringify({
            error: 'aborted',
            message: '工具执行已被取消（运行停止或超时）',
          }),
          isError: true,
        }
      }
      if (attempt < maxAttempts - 1) {
        logger.warn(`[tool:${name}] 重试 ${attempt + 1}`, error)
        await sleep(RETRY_DELAYS_MS[attempt])
      }
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError)
  return {
    toolUseId,
    content: JSON.stringify({ error: 'tool_failed', message }),
    isError: true,
  }
}

export function listToolDefs(): LlmToolDef[] {
  return Array.from(registry.values()).map((t) => ({
    name: t.def.name,
    description: t.def.description,
    input_schema: t.def.input_schema,
  }))
}

/** 列出所有非 MCP 工具（首页/编排默认底座，不含 mcp__*） */
export function listBuiltinToolDefs(): LlmToolDef[] {
  return listAgentToolDefs([])
}

/**
 * 从 `mcp__{serverId}__{toolName}` 解析 serverId；非 MCP 工具返回 null。
 * serverId 为 UUID（含连字符、无 `__`），toolName 可含下划线。
 */
export function mcpServerIdFromToolName(name: string): string | null {
  if (!name.startsWith('mcp__')) return null
  const rest = name.slice('mcp__'.length)
  const i = rest.indexOf('__')
  if (i <= 0) return null
  return rest.slice(0, i)
}

/**
 * 列出 agent 可见工具：全部 builtin + 显式暴露的 MCP server 工具（R1/R2）。
 * @param exposedMcpServerIds 已勾选 exposeToAgents 且当前已连接的 server id
 */
export function listAgentToolDefs(exposedMcpServerIds: Iterable<string> = []): LlmToolDef[] {
  const exposed = exposedMcpServerIds instanceof Set
    ? exposedMcpServerIds
    : new Set(exposedMcpServerIds)
  return Array.from(registry.values())
    .filter((t) => {
      const sid = mcpServerIdFromToolName(t.def.name)
      if (sid === null) return true
      return exposed.has(sid)
    })
    .map((t) => ({
      name: t.def.name,
      description: t.def.description,
      input_schema: t.def.input_schema,
    }))
}

export function getToolDefs(names: string[]): LlmToolDef[] {
  return names
    .map((n) => registry.get(n)?.def)
    .filter((d): d is ToolDef => !!d)
    .map((d) => ({
      name: d.name,
      description: d.description,
      input_schema: d.input_schema,
    }))
}

export function clearTools(): void {
  registry.clear()
}

/** 按名注销单个工具（MCP server 断开时用） */
export function unregisterTool(name: string): boolean {
  return registry.delete(name)
}

/** 按前缀注销工具（如 `mcp__serverId__` → 注销该 server 所有工具） */
export function unregisterByPrefix(prefix: string): number {
  let count = 0
  for (const key of registry.keys()) {
    if (key.startsWith(prefix)) {
      registry.delete(key)
      count++
    }
  }
  return count
}

/** 检查工具名是否已注册（MCP adapter 注册前冲突检测） */
export function hasTool(name: string): boolean {
  return registry.has(name)
}

// 生成工具调用 id（Anthropic 要求 toolu_ 前缀）
export function newToolUseId(): string {
  return `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`
}

/** Promise 超时包装：超时返回 null，不 reject（调用方自行处理） */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    timer.unref?.()
    p.then((v) => { clearTimeout(timer); resolve(v) })
      .catch(() => { clearTimeout(timer); resolve(null) })
  })
}

// —— Zod → JSON Schema（覆盖工具入参常用类型；zod v4 用 _def.type 字符串标识）——
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return buildJsonSchema(schema)
}

function buildJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as {
    type?: string
    shape?: Record<string, z.ZodTypeAny>
    valueType?: z.ZodTypeAny
    innerType?: z.ZodTypeAny
  }
  switch (def.type) {
    case 'object': {
      const shape = def.shape ?? {}
      const properties: Record<string, unknown> = {}
      const required: string[] = []
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = buildJsonSchema(v as z.ZodTypeAny)
        if (!(v as { isOptional?: () => boolean }).isOptional?.()) {
          required.push(k)
        }
      }
      const out: Record<string, unknown> = { type: 'object', properties }
      if (required.length) out.required = required
      return out
    }
    case 'string':
      return { type: 'string' }
    case 'number':
    case 'int':
      return { type: 'number' }
    case 'boolean':
      return { type: 'boolean' }
    case 'enum': {
      // z.enum(['a','b'])：zod v4 的 options 直接给可选值数组
      const opts = (schema as unknown as { options?: unknown[] }).options
      return { type: 'string', enum: opts ?? [] }
    }
    case 'array':
      return { type: 'array', items: def.valueType ? buildJsonSchema(def.valueType) : {} }
    case 'optional':
    case 'nullable':
    case 'default':
      return def.innerType ? buildJsonSchema(def.innerType) : {}
    default:
      return {}
  }
}
