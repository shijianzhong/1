import { z } from 'zod'
import type { WorkflowGraph } from '@shared/types'

// —— Zod 配置 schema（§5.3 + §10.2 契约）——
// 主进程读写 JSON 配置时校验；IPC 边界也用这些 schema 校验渲染层入参。
// 与 shared/types.ts 的接口手工对齐（shared 走渲染层，不引 zod 省 bundle）。

const ts = z.number().int().nonnegative()
const id = z.string().min(1)

/** registry 溯源（docs/REGISTRY_PLAN.md §2.1）；与 shared/types.ts RegistryProvenance 手工对齐 */
export const RegistryProvenanceSchema = z.object({
  registryId: z.string().min(1),
  version: z.string().min(1),
  author: z.string().optional(),
  importedAt: ts,
})

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
    /** P4: 远程 embedding 模型 id（kb 远程嵌入用） */
    embedding: z.string().optional(),
  }),
  enableThinking: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  createdAt: ts,
  updatedAt: ts,
})

export const AgentSchema = z.object({
  id,
  name: z.string().min(1),
  description: z.string().optional(),
  instructions: z.string(),
  skillIds: z.array(z.string()).optional(),
  /** 资产级工具白名单；缺省/空 = 不限制 */
  allowedToolNames: z.array(z.string()).optional(),
  modelId: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  outputConstraints: z.string().optional(),
  source: z.enum(['builtin', 'custom']).optional(),
  registry: RegistryProvenanceSchema.optional(),
  createdAt: ts,
  updatedAt: ts,
})

export const SkillSchema = z.object({
  id,
  name: z.string().min(1),
  description: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
  content: z.string(),
  discipline: z.string().optional(),
  hasScripts: z.boolean().optional(),
  registry: RegistryProvenanceSchema.optional(),
  /** 启停开关（frontmatter enabled，默认 true；false 时 skill-host 过滤不注入） */
  enabled: z.boolean().optional(),
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
  /** 能力级工具白名单（作用于该能力图内节点）；缺省/空 = 不限制 */
  allowedToolNames: z.array(z.string()).optional(),
  registry: RegistryProvenanceSchema.optional(),
  createdAt: ts,
  updatedAt: ts,
})

export const PersonaSchema = z.object({
  id,
  name: z.string().min(1),
  instructions: z.string(),
  modelId: z.string().optional(),
  skillIds: z.array(z.string()).optional(),
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
export const SkillInputSchema = SkillSchema.omit({ createdAt: true, updatedAt: true, hasScripts: true }).extend({
  id: z.string().optional(),
})
export const CapabilityInputSchema = CapabilitySchema.omit({ createdAt: true, updatedAt: true }).extend({
  id: z.string().optional(),
})
export const PersonaInputSchema = PersonaSchema.omit({ updatedAt: true })

// —— 内容生产知识资产 schema（docs/CONTENT_PIPELINE_PLAN.md §2.3）——

export const TopicMetaSchema = z.object({
  heatSignal: z.string().optional(),
  searchValue: z.string().optional(),
  benchmarkGap: z.string().optional(),
  verdict: z.string().optional(),
  angle: z.string().optional(),
  altAngles: z.array(z.string()).optional(),
  triFilter: z
    .object({
      heat: z.boolean().optional(),
      redSea: z.boolean().optional(),
      blank: z.boolean().optional(),
    })
    .optional(),
})

export const TopicSchema = z.object({
  id,
  userId: z.string().default('local'),
  title: z.string().min(1),
  direction: z.string().optional(),
  status: z.enum(['pending', 'researching', 'producing', 'published', 'archived']).default('pending'),
  recommendation: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  meta: TopicMetaSchema.optional(),
  tags: z.array(z.string()).optional(),
  createdAt: ts,
  updatedAt: ts,
})

export const TopicInputSchema = TopicSchema.omit({ createdAt: true, updatedAt: true }).extend({
  id: z.string().optional(),
})

export const AiCavityHitSchema = z.object({
  sentence: z.string(),
  type: z.enum(['self_invented_term', 'english_connection_misuse']),
  marker: z.string().optional(),
  suggestion: z.string().optional(),
})

export const ReviewNotesSchema = z.object({
  dimensions: z
    .object({
      title: z.number().min(0).max(2).optional(),
      opening: z.number().min(0).max(2).optional(),
      punchline: z.number().min(0).max(2).optional(),
      authenticity: z.number().min(0).max(2).optional(),
      interaction: z.number().min(0).max(2).optional(),
    })
    .optional(),
  total: z.number().min(0).max(10).optional(),
  benchmark: z.string().optional(),
  revisionPoints: z.array(z.string()).optional(),
  aiCavityHits: z.array(AiCavityHitSchema).optional(),
  finalTweaks: z.array(z.string()).optional(),
})

export const ReviewRecordSchema = z.object({
  id,
  userId: z.string().default('local'),
  assetType: z.string().min(1),
  assetId: z.string().min(1),
  score: z.number().min(0).max(10),
  verdict: z.enum(['可发', '需返工', '推倒重写']),
  notes: ReviewNotesSchema.optional(),
  createdAt: ts,
})

export const ReviewRecordInputSchema = ReviewRecordSchema.omit({ createdAt: true }).extend({
  id: z.string().optional(),
})

export const StyleProfileSchema = z.object({
  id,
  name: z.string().min(1),
  description: z.string().optional(),
  titleFormulas: z.array(z.string()).optional(),
  structureSkeleton: z.string().optional(),
  toneWords: z.array(z.string()).optional(),
  wordCountRange: z.string().optional(),
  interactionHooks: z.array(z.string()).optional(),
  bannedInventedTerms: z.array(z.string()).optional(),
  bannedEnglishConnections: z.array(z.string()).optional(),
  createdAt: ts,
  updatedAt: ts,
})

export const StyleProfileInputSchema = StyleProfileSchema.omit({ createdAt: true, updatedAt: true }).extend({
  id: z.string().optional(),
})

export const SampleArticleSchema = z.object({
  id,
  name: z.string().min(1),
  description: z.string().optional(),
  content: z.string(),
  source: z.string().optional(),
  tags: z.array(z.string()).optional(),
  hasReferences: z.boolean().optional(),
  wordCount: z.number().int().nonnegative().optional(),
  createdAt: ts,
  updatedAt: ts,
})

export const SampleArticleInputSchema = SampleArticleSchema.omit({ createdAt: true, updatedAt: true, hasReferences: true, wordCount: true }).extend({
  id: z.string().optional(),
})
