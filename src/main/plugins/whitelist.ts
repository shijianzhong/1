// —— generated/A 声明式工具白名单 + 注册点校验（docs/PLUGIN_ARCHITECTURE.md §3 + §6）——
//
// A 层"受控动作"必须是明确正列（whitelist），不是"任意既有工具名都放行"。
// 白名单校验发生在 GeneratedPlugin.onLoad（注册点）——非白名单动作 / 越界参数直接拒注册，
// fail-closed 于注册点。白名单 schema 字段集硬编码 map（正列字面体现，不从 registry 动态读，
// 防注册顺序导致白名单漂移）。
//
// 判发方式：A 工具 handler 内部调 executeTool(白名单动作名, params, ...) 复用全部闸门 +
// resolveConfined 围栏。白名单这里只校验"动作名 + 参数 subset"，不重复执行期校验。
//
// generated/B 代码型工具校验（§3 B 层 + §5 Stage 3）：validateGeneratedBSpec 校验
// handlerSource 非空 + 可编译（vm 编译期验语法）+ inputSchema 结构。B 无 executeAction，
// 不做白名单 action 校验；运行时白名单逃逸由 sandbox.ts 的 makeCtxExecuteTool 拦截。

import vm from 'node:vm'

/** 白名单动作名（注册工具名，非文件名）——只读/检索、无副作用子集 */
export const WHITELIST_ACTIONS = [
  'file_read',
  'file_search',
  'kb_search',
  'web_search',
  'glob',
  'grep',
  'skill_search',
  'load_skill',
] as const

export type WhitelistAction = (typeof WHITELIST_ACTIONS)[number]

/**
 * 白名单动作的参数 schema 字段集（正列，硬编码——非从 registry 动态读）。
 * 每个动作的字段 + 类型 + 约束来自其 registerTool 的 zod schema（见对应 builtin）。
 * generated/A 的 executeAction.params 必须是此 schema 的 pick/subset：
 * 字段须存在 + 类型兼容 + bounds 不得更宽（可收窄/缺省，不可放宽）。
 */
interface FieldSpec {
  /** JSON Schema type（generated 的 inputSchema 是 JSON Schema，此处用同口径校验） */
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array'
  /** 数值/数组 bounds（可选；generated 不得更宽） */
  min?: number
  max?: number
  /** 数组元素类型（type=array 时） */
  items?: 'string'
  /** 是否必填（generated 的 required 必须是此处的必填子集） */
  required?: boolean
}

const WHITELIST_PARAM_SCHEMAS: Record<WhitelistAction, Record<string, FieldSpec>> = {
  file_read: {
    path: { type: 'string', required: true },
  },
  file_search: {
    query: { type: 'string', required: true },
    maxResults: { type: 'integer', min: 1, max: 100 },
  },
  kb_search: {
    query: { type: 'string', required: true },
    k: { type: 'integer', min: 1, max: 20 },
    docIds: { type: 'array', items: 'string' },
  },
  web_search: {
    query: { type: 'string', required: true },
  },
  glob: {
    pattern: { type: 'string', required: true },
    path: { type: 'string' },
    maxResults: { type: 'integer', min: 1, max: 200 },
  },
  grep: {
    pattern: { type: 'string', required: true },
    path: { type: 'string' },
    glob: { type: 'string' },
    output_mode: { type: 'string' },
    maxResults: { type: 'integer', min: 1, max: 100 },
  },
  skill_search: {
    keywords: { type: 'string', required: true },
    limit: { type: 'integer', min: 1, max: 20 },
  },
  load_skill: {
    id: { type: 'string', required: true },
  },
}

/** 校验结果（判别联合，拒绝时带 reason + i18n messageKey） */
export type ValidateResult =
  | { ok: true }
  | { ok: false; reason: ValidateFailureReason; messageKey: string }

export type ValidateFailureReason =
  | 'action_not_whitelisted'
  | 'params_not_subset'
  | 'param_type_mismatch'
  | 'param_bound_too_wide'
  | 'required_missing'
  | 'invalid_input_schema'
  | 'handler_source_empty'
  | 'compile_failed'

/**
 * generated/A spec 的动作声明部分（与 GeneratedPluginSpec 对齐，此处只取校验所需子集）。
 * inputSchema 是 JSON Schema（LLM 可见），executeAction.action + executeAction.params 是判发目标。
 */
interface GeneratedSpecLike {
  inputSchema?: unknown
  executeAction: {
    action: string
    params?: Record<string, unknown>
  }
}

/**
 * 校验 generated/A spec 是否符合白名单约束（注册点调用）。
 *
 * 1. action 必须在白名单正列
 * 2. params 的每个字段必须在白名单 schema 存在（不得新增被动动作没有的参数）
 * 3. 字段类型兼容
 * 4. bounds 不得更宽（generated 的 min 不得小于白名单 min / max 不得大于白名单 max）
 * 5. 必填字段须存在
 *
 * 拒绝一律返回 { ok:false, reason, messageKey }，调用方据此不注册 + 记 pluginEvents。
 */
export function validateGeneratedSpec(spec: GeneratedSpecLike): ValidateResult {
  const { action, params } = spec.executeAction

  // 1. action 在白名单
  if (!WHITELIST_ACTIONS.includes(action as WhitelistAction)) {
    return {
      ok: false,
      reason: 'action_not_whitelisted',
      messageKey: 'errors.plugins.action_not_whitelisted',
    }
  }
  const allowedFields = WHITELIST_PARAM_SCHEMAS[action as WhitelistAction]

  // inputSchema 基本结构校验（非完整 JSON Schema 校验，只防明显畸形）
  const schema = spec.inputSchema
  if (
    schema !== undefined &&
    (typeof schema !== 'object' ||
      schema === null ||
      (schema as Record<string, unknown>).type !== 'object')
  ) {
    return {
      ok: false,
      reason: 'invalid_input_schema',
      messageKey: 'errors.plugins.invalid_input_schema',
    }
  }

  const declared = params ?? {}
  // 2. 每个声明字段须在白名单 schema 存在（不得 superset）
  for (const key of Object.keys(declared)) {
    const allowed = allowedFields[key]
    if (!allowed) {
      return {
        ok: false,
        reason: 'params_not_subset',
        messageKey: 'errors.plugins.params_not_subset',
      }
    }
    // 3. 类型兼容
    const val = declared[key]
    if (!typeCompatible(val, allowed)) {
      return {
        ok: false,
        reason: 'param_type_mismatch',
        messageKey: 'errors.plugins.param_type_mismatch',
      }
    }
    // 4. bounds 不得更宽（generated 的数值/数组长度不得超出白名单上界，
    //    也不得低于白名单下界——下界收窄无意义且易误导，统一不允许更宽）
    if (!boundNotWider(val, allowed)) {
      return {
        ok: false,
        reason: 'param_bound_too_wide',
        messageKey: 'errors.plugins.param_bound_too_wide',
      }
    }
  }

  // 5. 白名单必填字段须在 declared 中出现（generated 可 pick，但被 pick 的必填项
  //    仍须显式声明——防"声明了动作却漏了必填参数"导致运行时 zod 校验失败）
  for (const [key, field] of Object.entries(allowedFields)) {
    if (field.required && !(key in declared)) {
      return {
        ok: false,
        reason: 'required_missing',
        messageKey: 'errors.plugins.required_missing',
      }
    }
  }

  return { ok: true }
}

/** JSON 值与 FieldSpec 类型是否兼容 */
function typeCompatible(val: unknown, spec: FieldSpec): boolean {
  switch (spec.type) {
    case 'string':
      return typeof val === 'string'
    case 'integer':
      return typeof val === 'number' && Number.isInteger(val)
    case 'number':
      return typeof val === 'number'
    case 'boolean':
      return typeof val === 'boolean'
    case 'array':
      return Array.isArray(val) && (spec.items === undefined || val.every((v) => typeof v === 'string'))
    default:
      return false
  }
}

/** generated 声明的值/约束不得比白名单更宽 */
function boundNotWider(val: unknown, spec: FieldSpec): boolean {
  if (spec.type === 'integer' || spec.type === 'number') {
    const n = val as number
    if (spec.min !== undefined && n < spec.min) return false
    if (spec.max !== undefined && n > spec.max) return false
  }
  if (spec.type === 'array' && spec.max !== undefined) {
    return (val as unknown[]).length <= spec.max
  }
  return true
}

// —— generated/B 代码型工具校验（§3 B 层 + §5 Stage 3）——

/** B spec 的 handler 声明部分（只取校验所需子集） */
interface GeneratedBSpecLike {
  inputSchema?: unknown
  handlerSource?: unknown
}

/**
 * 校验 generated/B spec：handlerSource 非空 + 可编译 + inputSchema 结构。
 * 不做白名单 action 校验（B 无 executeAction）；运行时白名单逃逸由 sandbox.makeCtxExecuteTool 拦截。
 *
 * 1. handlerSource 非空字符串（trim 后 > 0）→ 否则 handler_source_empty
 * 2. handlerSource 可编译：vm.runInNewContext 包成 (function(executeTool){ return async function handler(args, ctx){ <src> } })，
 *    尝试编译（不执行），catch SyntaxError → compile_failed
 * 3. inputSchema 结构：复用 A 层逻辑（type==='object' 或 undefined）→ invalid_input_schema
 */
export function validateGeneratedBSpec(spec: GeneratedBSpecLike): ValidateResult {
  const source = spec.handlerSource
  if (typeof source !== 'string' || source.trim().length === 0) {
    return {
      ok: false,
      reason: 'handler_source_empty',
      messageKey: 'errors:plugins.handler_source_empty',
    }
  }

  // inputSchema 基本结构校验（复用 A 层口径：非 undefined 时须 type=object）
  const schema = spec.inputSchema
  if (
    schema !== undefined &&
    (typeof schema !== 'object' ||
      schema === null ||
      (schema as Record<string, unknown>).type !== 'object')
  ) {
    return {
      ok: false,
      reason: 'invalid_input_schema',
      messageKey: 'errors:plugins.invalid_input_schema',
    }
  }

  // 可编译校验：vm 编译期验语法（不执行 handler 体）
  try {
    const wrapped = `(function(executeTool){ return async function handler(args, ctx){ ${source} } })`
    // 不设 timeout——编译步仅建函数对象、不执行 handler 体；Node vm 拒绝 timeout:0（须省略），否则抛 RangeError 使校验必败
    vm.runInNewContext(wrapped, {}, { filename: 'generatedB/validate.handler.js' })
  } catch {
    return {
      ok: false,
      reason: 'compile_failed',
      messageKey: 'errors:plugins.compile_failed',
    }
  }

  return { ok: true }
}
