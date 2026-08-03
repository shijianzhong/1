import { z } from 'zod'
import type { WorkflowGraph } from '@shared/types'

// —— Registry 远端数据 Zod 校验（docs/REGISTRY_PLAN.md §1）——
// manifest/index 来自远端仓库（含手写 PR），进内存前必须过 schema；
// 与 shared/types.ts 的 Registry* 接口手工对齐。

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)

export const RegistryIndexEntrySchema = z.object({
  id: slug,
  name: z.string().min(1),
  description: z.string().optional(),
  author: z.string().optional(),
  version: z.string().optional(),
  tags: z.array(z.string()).optional(),
  hasScripts: z.boolean().optional(),
  hasDiscipline: z.boolean().optional(),
  updatedAt: z.string().optional(),
})

export const RegistryIndexSchema = z.object({
  version: z.number().int().positive(),
  updated: z.string().optional(),
  agents: z.array(RegistryIndexEntrySchema).default([]),
  skills: z.array(RegistryIndexEntrySchema).default([]),
  capabilities: z.array(RegistryIndexEntrySchema).default([]),
})

const manifestBase = {
  id: slug,
  name: z.string().min(1),
  description: z.string().optional(),
  author: z.string().optional(),
  version: z.string().min(1),
  tags: z.array(z.string()).optional(),
  updatedAt: z.string().optional(),
}

export const RegistryAgentManifestSchema = z.object({
  ...manifestBase,
  instructions: z.string(),
  skillIds: z.array(slug).optional(),
  modelHint: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  outputConstraints: z.string().optional(),
})

export const RegistrySkillManifestSchema = z.object({
  ...manifestBase,
  skillZip: z.string().min(1),
  hasScripts: z.boolean().optional(),
  hasDiscipline: z.boolean().optional(),
})

export const RegistryCapabilityManifestSchema = z.object({
  ...manifestBase,
  // graph 黑盒校验（与 CapabilitySchema 一致：节点/边结构由编排引擎侧保证）
  graph: z.custom<WorkflowGraph>((val) => {
    if (typeof val !== 'object' || val === null) return false
    const g = val as { nodes?: unknown; edges?: unknown }
    return Array.isArray(g.nodes) && Array.isArray(g.edges)
  }),
  dependencies: z
    .object({
      agents: z.array(slug).optional(),
      skills: z.array(slug).optional(),
    })
    .optional(),
})
