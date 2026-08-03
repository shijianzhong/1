import {
  AgentInputSchema,
  AgentSchema,
  CapabilityInputSchema,
  CapabilitySchema,
  ModelConfigInputSchema,
  ModelConfigSchema,
  PersonaInputSchema,
  PersonaSchema,
  ProviderInputSchema,
  ProviderSchema,
  SkillInputSchema,
  SkillSchema,
} from '../config'
import {
  getAgentsPath,
  getCapabilitiesDir,
  getModelsPath,
  getPersonaPath,
  getProvidersPath,
  getSkillsPath,
} from './paths'
import {
  JsonCollection,
  JsonSingleton,
  generateId,
} from './json-store'
import { rm } from 'node:fs/promises'
import { getKey } from '../secrets/vault'
import { getSkillUploadTempDir } from '../skills/upload'
import type {
  Agent,
  ApiFormat,
  Capability,
  ModelConfig,
  Persona,
  Provider,
  ProviderModels,
  Skill,
} from '@shared/types'
import { resolveModelIdByUsage } from '@shared/types'

// —— models：单文件存储（userData/config/models.json）——
const modelsStore = new JsonSingleton<ModelConfig[]>(
  getModelsPath(),
  [],
  (raw) => {
    const arr = Array.isArray(raw) ? raw : []
    return arr
      .map((r) => ModelConfigSchema.safeParse(r))
      .filter((r) => r.success)
      .map((r) => r.data)
  },
)

export function listModels(): ModelConfig[] {
  return modelsStore.read()
}

export function getModel(id: string): ModelConfig | null {
  return listModels().find((m) => m.id === id) ?? null
}

export function getDefaultModel(): ModelConfig | null {
  return listModels().find((m) => m.isDefault) ?? listModels()[0] ?? null
}

export function saveModel(input: unknown): ModelConfig {
  const parsed = ModelConfigInputSchema.parse(input)
  const now = Date.now()
  const models = listModels()
  // 新建或更新
  const existing = parsed.id ? models.find((m) => m.id === parsed.id) : null
  const isDefault = parsed.isDefault
  // keyId 逻辑：挂 provider 的模型不自带 keyId（key 在 provider 级）；
  // 旧式独立模型（无 providerId）保留 keyId 自动生成。
  const keyId = parsed.providerId
    ? existing?.keyId ?? parsed.keyId
    : existing?.keyId ?? parsed.keyId ?? generateId('key_')
  const next: ModelConfig = {
    id: existing?.id ?? generateId('mdl_'),
    modelId: parsed.modelId,
    name: parsed.name,
    providerId: parsed.providerId,
    baseUrl: parsed.baseUrl || undefined,
    keyId,
    isDefault: parsed.isDefault,
    tags: parsed.tags,
    maxTokens: parsed.maxTokens ?? 16384, // 铁律8 缺省
    temperature: parsed.temperature,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  // 先把 next 加入/替换到列表
  const withNext = existing
    ? models.map((m) => (m.id === next.id ? next : m))
    : [...models, next]
  // 设为默认时取消其它默认
  const updated = isDefault
    ? withNext.map((m) => (m.id === next.id ? next : { ...m, isDefault: false }))
    : withNext
  modelsStore.write(updated)
  return next
}

export function removeModel(id: string): void {
  modelsStore.write(listModels().filter((m) => m.id !== id))
}

// —— capabilities：多文件（userData/config/capabilities/{id}.json）——
const capabilitiesStore = new JsonCollection<Capability>(
  getCapabilitiesDir(),
  (raw) => CapabilitySchema.parse(raw),
)

export function listCapabilities(): Capability[] {
  return capabilitiesStore.list().sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getCapability(id: string): Capability | null {
  return capabilitiesStore.get(id)
}

export function saveCapability(input: unknown, opts?: { now?: number }): Capability {
  const parsed = CapabilityInputSchema.parse(input)
  const now = opts?.now ?? Date.now() // 见 saveAgent 注释
  const existing = parsed.id ? getCapability(parsed.id) : null
  const next: Capability = {
    id: existing?.id ?? generateId('cap_'),
    name: parsed.name,
    description: parsed.description,
    graph: parsed.graph,
    // 编辑保存不带 registry 字段时保留既有溯源（导入/发布才显式写入）
    registry: parsed.registry ?? existing?.registry,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  capabilitiesStore.save(next)
  return next
}

export function removeCapability(id: string): void {
  capabilitiesStore.remove(id)
}

// —— agents（角色）：多文件（userData/config/agents/{id}.json）——
const agentsStore = new JsonCollection<Agent>(getAgentsPath(), (raw) =>
  AgentSchema.parse(raw),
)

export function listAgents(): Agent[] {
  return agentsStore.list().sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getAgent(id: string): Agent | null {
  return agentsStore.get(id)
}

export function saveAgent(input: unknown, opts?: { now?: number }): Agent {
  const parsed = AgentInputSchema.parse(input)
  // registry 导入方注入统一的 now：使 provenance.importedAt 与 updatedAt 严格相等，
  // 保证「本地已修改」判定（updatedAt > importedAt）在导入后不会误报
  const now = opts?.now ?? Date.now()
  const existing = parsed.id ? getAgent(parsed.id) : null
  const next: Agent = {
    id: existing?.id ?? generateId('agt_'),
    name: parsed.name,
    description: parsed.description,
    instructions: parsed.instructions,
    skillIds: parsed.skillIds,
    modelId: parsed.modelId,
    temperature: parsed.temperature,
    maxTokens: parsed.maxTokens ?? 16384,
    outputConstraints: parsed.outputConstraints,
    source: parsed.source ?? 'custom',
    registry: parsed.registry ?? existing?.registry,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  agentsStore.save(next)
  return next
}

export function removeAgent(id: string): void {
  agentsStore.remove(id)
}

// —— skills：多文件（userData/config/skills/{id}.json）——
const skillsStore = new JsonCollection<Skill>(getSkillsPath(), (raw) =>
  SkillSchema.parse(raw),
)

export function listSkills(): Skill[] {
  return skillsStore.list().sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getSkill(id: string): Skill | null {
  return skillsStore.get(id)
}

export function saveSkill(input: unknown, opts?: { now?: number }): Skill {
  const parsed = SkillInputSchema.parse(input)
  const now = opts?.now ?? Date.now() // 见 saveAgent 注释
  const existing = parsed.id ? getSkill(parsed.id) : null
  const next: Skill = {
    id: existing?.id ?? generateId('skl_'),
    name: parsed.name,
    description: parsed.description,
    content: parsed.content,
    // 编辑表单不携带 discipline 时保留既有值（防编辑保存误清 propose_skill/导入写入的纪律段）
    discipline: parsed.discipline ?? existing?.discipline,
    scriptPath: parsed.scriptPath,
    registry: parsed.registry ?? existing?.registry,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  skillsStore.save(next)
  return next
}

export function removeSkill(id: string): void {
  // 顺带清理上传/导入留下的解压临时目录（skl_upload_ 前缀，防磁盘积累孤立文件）
  const scriptPath = getSkill(id)?.scriptPath
  if (scriptPath) {
    const tempDir = getSkillUploadTempDir(scriptPath)
    if (tempDir) void rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
  skillsStore.remove(id)
}

// —— persona：单文件（首页主助手人设，独立于角色）——
const personaStore = new JsonSingleton<Persona | null>(getPersonaPath(), null, (raw) => {
  if (raw === null) return null
  const r = PersonaSchema.safeParse(raw)
  return r.success ? r.data : null
})

export function getPersona(): Persona | null {
  return personaStore.read()
}

export function savePersona(input: unknown): Persona {
  const parsed = PersonaInputSchema.parse(input)
  const next: Persona = {
    id: 'home',
    name: parsed.name,
    instructions: parsed.instructions,
    modelId: parsed.modelId,
    skillIds: parsed.skillIds,
    profile: parsed.profile,
    updatedAt: Date.now(),
  }
  personaStore.write(next)
  return next
}

// —— 预置：首次启动 seed 一个 Anthropic provider + 三个 Claude 模型挂上去 ——
// —— 预置：首次启动 seed 一个完整 Anthropic 供应商（带用途模型）——
const PRESET_PROVIDERS: Array<Omit<Provider, 'createdAt' | 'updatedAt'>> = [
  {
    id: 'preset_anthropic',
    name: 'Anthropic',
    remark: 'Claude 官方，填入 API Key 即用',
    website: 'https://www.anthropic.com',
    baseUrl: undefined, // 官方 endpoint
    apiFormat: 'anthropic',
    authHeader: undefined, // anthropic 格式默认 x-api-key
    keyId: 'preset_key_anthropic',
    models: {
      primary: 'claude-sonnet-5',
      reasoning: 'claude-opus-5',
      fast: 'claude-haiku-4-5-20251001',
      default: 'claude-sonnet-5',
    },
  },
]

/** 首次启动无供应商时 seed 预置（cc switch 范式：供应商为中心） */
export function seedDefaultModels(): void {
  if (listProviders().length > 0) return
  const now = Date.now()
  providersStore.write(
    PRESET_PROVIDERS.map((p) => ({ ...p, createdAt: now, updatedAt: now }) as Provider),
  )
}

// —— providers：单文件存储（userData/config/providers.json）——
const providersStore = new JsonSingleton<Provider[]>(
  getProvidersPath(),
  [],
  (raw) => {
    const arr = Array.isArray(raw) ? raw : []
    return arr
      .map((r) => ProviderSchema.safeParse(r))
      .filter((r) => r.success)
      .map((r) => r.data)
  },
)

export function listProviders(): Provider[] {
  return providersStore.read()
}

export function getProvider(id: string): Provider | null {
  return listProviders().find((p) => p.id === id) ?? null
}

export function saveProvider(input: unknown): Provider {
  const parsed = ProviderInputSchema.parse(input)
  const now = Date.now()
  const existing = parsed.id ? getProvider(parsed.id) : null
  const isDefault = parsed.isDefault
  const next: Provider = {
    id: existing?.id ?? generateId('prv_'),
    name: parsed.name,
    remark: parsed.remark || undefined,
    website: parsed.website || undefined,
    baseUrl: parsed.baseUrl || undefined,
    apiFormat: parsed.apiFormat ?? 'anthropic',
    authHeader: parsed.authHeader || undefined,
    keyId: existing?.keyId ?? parsed.keyId ?? generateId('key_'),
    models: parsed.models ?? {},
    enableThinking: parsed.enableThinking,
    isDefault: isDefault ?? false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  const list = listProviders()
  // 设为默认时取消其它默认
  const updated = isDefault
    ? list.map((p) => (p.id === next.id ? next : { ...p, isDefault: false }))
    : existing
      ? list.map((p) => (p.id === next.id ? next : p))
      : [...list, next]
  providersStore.write(updated)
  return next
}

export function removeProvider(id: string): void {
  providersStore.write(listProviders().filter((p) => p.id !== id))
}

/** 取默认供应商（有 isDefault 标记的优先，否则取第一个） */
export function getDefaultProvider(): Provider | null {
  const list = listProviders()
  return list.find((p) => p.isDefault) ?? list[0] ?? null
}

/**
 * 解析供应商凭据 + 默认 modelId（cc switch 范式：key 在 provider 级共享）。
 * @returns { apiKey?, baseURL?, authHeader?, apiFormat?, modelId? }
 */
export function resolveProviderCredentials(
  provider: Pick<Provider, 'keyId' | 'baseUrl' | 'authHeader' | 'apiFormat' | 'models' | 'enableThinking'>,
  usage: keyof import('@shared/types').ProviderModels = 'default',
): {
  apiKey?: string
  baseURL?: string
  authHeader?: string
  apiFormat?: import('@shared/types').ApiFormat
  modelId?: string
  enableThinking?: boolean
} {
  const apiKey = provider.keyId ? getKey(provider.keyId) ?? undefined : undefined
  return {
    apiKey,
    baseURL: provider.baseUrl || undefined,
    authHeader: provider.authHeader,
    apiFormat: provider.apiFormat,
    modelId: resolveModelIdByUsage({ models: provider.models }, usage),
    enableThinking: provider.enableThinking ?? false,
  }
}

