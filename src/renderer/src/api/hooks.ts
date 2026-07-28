import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { unwrap } from './client'
import type {
  Agent,
  Capability,
  ModelConfig,
  Persona,
  Skill,
} from '@shared/types'

// —— TanStack Query hooks（§5.6）——
// 集中管理服务端态（能力/角色/技能/模型列表），缓存与失效。
// IPC 返回 Promise<IpcResult<T>>，.then(unwrap) 解包失败抛 IpcError。

const thenUnwrap = <T>(p: Promise<{ ok: true; data: T } | { ok: false; code: string; message: string; retryable: boolean }>): Promise<T> =>
  p.then(unwrap)

// —— 模型 ——
export function useModels() {
  return useQuery({
    queryKey: ['models'],
    queryFn: () => thenUnwrap(window.one.models.list()),
  })
}

export function useSaveModel() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Parameters<typeof window.one.models.save>[0]) =>
      thenUnwrap(window.one.models.save(input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['models'] }),
  })
}

export function useRemoveModel() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => thenUnwrap(window.one.models.remove(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['models'] }),
  })
}

// —— 角色 ——
export function useAgents() {
  return useQuery({
    queryKey: ['agents'],
    queryFn: () => thenUnwrap(window.one.agents.list()),
  })
}

export function useSaveAgent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Parameters<typeof window.one.agents.save>[0]) =>
      thenUnwrap(window.one.agents.save(input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents'] }),
  })
}

export function useRemoveAgent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => thenUnwrap(window.one.agents.remove(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents'] }),
  })
}

// —— 技能 ——
export function useSkills() {
  return useQuery({
    queryKey: ['skills'],
    queryFn: () => thenUnwrap(window.one.skills.list()),
  })
}

export function useSaveSkill() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Parameters<typeof window.one.skills.save>[0]) =>
      thenUnwrap(window.one.skills.save(input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills'] }),
  })
}

export function useRemoveSkill() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => thenUnwrap(window.one.skills.remove(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills'] }),
  })
}

// —— 能力 ——
export function useCapabilities() {
  return useQuery({
    queryKey: ['capabilities'],
    queryFn: () => thenUnwrap(window.one.capabilities.list()),
  })
}

export function useSaveCapability() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Parameters<typeof window.one.capabilities.save>[0]) =>
      thenUnwrap(window.one.capabilities.save(input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['capabilities'] }),
  })
}

export function useRemoveCapability() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => thenUnwrap(window.one.capabilities.remove(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['capabilities'] }),
  })
}

// —— 人设 ——
export function usePersona() {
  return useQuery({
    queryKey: ['persona'],
    queryFn: () => thenUnwrap(window.one.persona.get()),
  })
}

export function useSavePersona() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Parameters<typeof window.one.persona.save>[0]) =>
      thenUnwrap(window.one.persona.save(input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['persona'] }),
  })
}

export type { Agent, Capability, ModelConfig, Persona, Skill }

// —— 任务历史 ——
export function useTasks() {
  return useQuery({
    queryKey: ['tasks'],
    queryFn: () => thenUnwrap(window.one.tasks.list()),
  })
}

// —— 会话历史 ——
export function useSessions() {
  return useQuery({
    queryKey: ['sessions'],
    queryFn: () => thenUnwrap(window.one.sessions.list()),
  })
}

export function useRemoveSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => thenUnwrap(window.one.sessions.remove(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  })
}

// —— 单个能力（画布加载/存图用）——
export function useCapability(id?: string) {
  return useQuery({
    queryKey: ['capability', id],
    queryFn: () => thenUnwrap(window.one.capabilities.get(id!)),
    enabled: !!id,
  })
}
