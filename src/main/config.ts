import { z } from 'zod'
import type { WorkflowGraph } from '@shared/types'

// —— Zod 配置 schema（§5.3 + §10.2 契约）——
// 主进程读写 JSON 配置时校验；IPC 边界也用这些 schema 校验渲染层入参。
// 与 shared/types.ts 的接口手工对齐（shared 走渲染层，不引 zod 省 bundle）。

const ts = z.number().int().nonnegative()
const id = z.string().min(1)

export const ModelConfigSchema = z.object({
  id,
  modelId: z.string().min(1),
  name: z.string().min(1),
  providerId: z.string().optional(),
  baseUrl: z.string().url().optional().or(z.literal('')),
  keyId: z.string().optional(),
  isDefault: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  createdAt: ts,
  updatedAt: ts,
})

export const ProviderSchema = z.object({
  id,
  name: z.string().min(1),
  remark: z.string().optional(),
  website: z.string().url().optional().or(z.literal('')),
  baseUrl: z.string().url().optional().or(z.literal('')),
  apiFormat: z.enum(['anthropic', 'openai', 'custom']),
  authHeader: z.string().optional(),
  keyId: z.string().optional(),
  models: z.object({
    primary: z.string().optional(),
    reasoning: z.string().optional(),
    fast: z.string().optional(),
    default: z.string().optional(),
  }),
  enableThinking: z.boolean().optional(),
  createdAt: ts,
  updatedAt: ts,
})

export const AgentSchema = z.object({
  id,
  name: z.string().min(1),
  description: z.string().optional(),
  instructions: z.string(),
  skillIds: z.array(z.string()).optional(),
  modelId: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  outputConstraints: z.string().optional(),
  source: z.enum(['builtin', 'custom']).optional(),
  createdAt: ts,
  updatedAt: ts,
})

export const SkillSchema = z.object({
  id,
  name: z.string().min(1),
  description: z.string().optional(),
  content: z.string(),
  discipline: z.string().optional(),
  scriptPath: z.string().optional(),
  createdAt: ts,
  updatedAt: ts,
})

export const CapabilitySchema = z.object({
  id,
  name: z.string().min(1),
  description: z.string().optional(),
  // graph 作为黑盒持久化（编排引擎阶段才校验节点/边结构）
  graph: z.custom<WorkflowGraph>((val) => {
    if (typeof val !== 'object' || val === null) return false
    const g = val as { nodes?: unknown; edges?: unknown }
    return Array.isArray(g.nodes) && Array.isArray(g.edges)
  }),
  createdAt: ts,
  updatedAt: ts,
})

export const PersonaSchema = z.object({
  id,
  name: z.string().min(1),
  instructions: z.string(),
  modelId: z.string().optional(),
  profile: z
    .object({
      alias: z.string().optional(),
      role: z.string().optional(),
      preferredLanguage: z.enum(['zh-CN', 'en']).optional(),
    })
    .optional(),
  updatedAt: ts,
})

/** 渲染层入参（save 时不带服务端生成的 ts/id 字段）的宽松 schema */
export const ModelConfigInputSchema = ModelConfigSchema.omit({ createdAt: true, updatedAt: true }).extend({
  id: z.string().optional(), // 新建时无 id
})
export const ProviderInputSchema = ProviderSchema.omit({ createdAt: true, updatedAt: true }).extend({
  id: z.string().optional(),
})
export const AgentInputSchema = AgentSchema.omit({ createdAt: true, updatedAt: true }).extend({
  id: z.string().optional(),
})
export const SkillInputSchema = SkillSchema.omit({ createdAt: true, updatedAt: true }).extend({
  id: z.string().optional(),
})
export const CapabilityInputSchema = CapabilitySchema.omit({ createdAt: true, updatedAt: true }).extend({
  id: z.string().optional(),
})
export const PersonaInputSchema = PersonaSchema.omit({ updatedAt: true })
