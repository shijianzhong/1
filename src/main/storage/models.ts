import {
  AgentInputSchema,
  AgentSchema,
  CapabilityInputSchema,
  CapabilitySchema,
  ModelConfigInputSchema,
  ModelConfigSchema,
  PersonaInputSchema,
  PersonaSchema,
  SkillInputSchema,
  SkillSchema,
} from '../config'
import {
  getAgentsPath,
  getCapabilitiesDir,
  getModelsPath,
  getPersonaPath,
  getSkillsPath,
} from './paths'
import {
  JsonCollection,
  JsonSingleton,
  generateId,
} from './json-store'
import type { Agent, Capability, ModelConfig, Persona, Skill } from '@shared/types'

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
  const next: ModelConfig = {
    id: existing?.id ?? generateId('mdl_'),
    modelId: parsed.modelId,
    name: parsed.name,
    baseUrl: parsed.baseUrl || undefined,
    keyId: parsed.keyId,
    isDefault: parsed.isDefault,
    maxTokens: parsed.maxTokens ?? 16384, // 铁律8 缺省
    temperature: parsed.temperature,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  // 设为默认时取消其它默认
  const updated = isDefault
    ? models.map((m) => (m.id === next.id ? next : { ...m, isDefault: false }))
    : [...models.filter((m) => m.id !== next.id), next]
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

export function saveCapability(input: unknown): Capability {
  const parsed = CapabilityInputSchema.parse(input)
  const now = Date.now()
  const existing = parsed.id ? getCapability(parsed.id) : null
  const next: Capability = {
    id: existing?.id ?? generateId('cap_'),
    name: parsed.name,
    description: parsed.description,
    graph: parsed.graph,
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

export function saveAgent(input: unknown): Agent {
  const parsed = AgentInputSchema.parse(input)
  const now = Date.now()
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

export function saveSkill(input: unknown): Skill {
  const parsed = SkillInputSchema.parse(input)
  const now = Date.now()
  const existing = parsed.id ? getSkill(parsed.id) : null
  const next: Skill = {
    id: existing?.id ?? generateId('skl_'),
    name: parsed.name,
    description: parsed.description,
    content: parsed.content,
    discipline: parsed.discipline,
    scriptPath: parsed.scriptPath,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  skillsStore.save(next)
  return next
}

export function removeSkill(id: string): void {
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
    profile: parsed.profile,
    updatedAt: Date.now(),
  }
  personaStore.write(next)
  return next
}
