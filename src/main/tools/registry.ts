import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { LlmToolDef } from '@shared/types'
import { logger } from '../logger'

// —— 工具注册表（§三之三 J + 铁律11）——
// registerTool 把普通函数包成 FunctionTool，**必须显式构造 JSON Schema
// 传给 LLM**（否则 LLM 看到无参数工具）。工具调用失败重试 3 次后返回错误
// JSON 不抛异常（抛异常会让 agent 再次调用形成死循环）。

const RETRY_DELAYS_MS = [500, 1000, 1500]

export type ToolApprovalMode = 'auto' | 'always' | 'never'

export interface ToolDef extends LlmToolDef {
  approvalMode?: ToolApprovalMode
}

export interface ToolContext {
  sessionId?: string
  signal?: AbortSignal
  /** 创建提案回调（propose_* 工具 → home IPC emitStream 桥，由 home.ts 注入） */
  onPropose?: (draft: import('@shared/types').CreateDraft) => void
  /** HITL 提问桥（ask_user 工具 → request_info 事件 + 挂起等待，由编排 IPC 注入）；
   *  未注入 = 当前运行环境不可与用户交互，ask_user 返回 user_input_unavailable */
  onAskUser?: (req: { question: string; context?: string }) => Promise<string>
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
 */
export function registerTool(
  name: string,
  description: string,
  params: z.ZodTypeAny,
  handler: ToolHandler,
  approvalMode: ToolApprovalMode = 'auto',
): RegisteredTool {
  const def: ToolDef = {
    name,
    description,
    input_schema: zodToJsonSchema(params),
    approvalMode,
  }
  const entry: RegisteredTool = { def, handler, zodSchema: params }
  registry.set(name, entry)
  return entry
}

/** 执行工具：校验入参 + 失败重试 3 次后返回错误 JSON 不抛（铁律11） */
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
      content: JSON.stringify({ error: 'invalid_args', detail: r.error.issues }),
      isError: true,
    }
  }

  // 重试 3 次，失败返回错误 JSON 不抛（铁律11）
  let lastError: unknown
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const result = await entry.handler(r.data, ctx)
      return {
        toolUseId,
        content: typeof result === 'string' ? result : JSON.stringify(result),
        isError: false,
      }
    } catch (error) {
      lastError = error
      if (attempt < RETRY_DELAYS_MS.length) {
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

// 生成工具调用 id（Anthropic 要求 toolu_ 前缀）
export function newToolUseId(): string {
  return `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`
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
