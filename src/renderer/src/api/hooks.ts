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
  RegistryAssetKind,
  RegistryConfig,
  RegistryExportConfirmItem,
  ReviewRecord,
  SampleArticle,
  Skill,
  SkillMeta,
  StyleProfile,
  Topic,
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

/** 单条技能（含 content），编辑时懒加载 */
export function useSkill(id: string | null | undefined) {
  return useQuery({
    queryKey: ['skill', id],
    queryFn: () => thenUnwrap(window.one.skills.get(id!)),
    enabled: !!id,
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

/** 上传技能包（.zip）→ 解析+保存+资源提取一步到位，返回完整 Skill */
export function usePickSkillFile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => thenUnwrap(window.one.skills.pickFile()),
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
    onSuccess: () => {
      // 列表查询（复数前缀）
      qc.invalidateQueries({ queryKey: ['capabilities'] })
      // 单个能力查询（单数前缀，queryKey = ['capability', id]）
      // 不 invalidate 会导致保存后重进画布拿到旧缓存
      qc.invalidateQueries({ queryKey: ['capability'] })
    },
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

export type { Agent, Capability, ModelConfig, Persona, Skill, SkillMeta }

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

// —— Provider（同一服务商多模型共享 key+baseUrl）——
export function useProviders() {
  return useQuery({
    queryKey: ['providers'],
    queryFn: () => thenUnwrap(window.one.providers.list()),
  })
}

export function useSaveProvider() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Parameters<typeof window.one.providers.save>[0]) =>
      thenUnwrap(window.one.providers.save(input)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['providers'] })
      qc.invalidateQueries({ queryKey: ['models'] })
    },
  })
}

export function useRemoveProvider() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => thenUnwrap(window.one.providers.remove(id)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['providers'] })
      qc.invalidateQueries({ queryKey: ['models'] })
    },
  })
}

export type { Provider } from '@shared/types'

// —— Registry（docs/REGISTRY_PLAN.md §3.1/§3.2）——
export function useRegistryConfig() {
  return useQuery({
    queryKey: ['registry', 'config'],
    queryFn: () => thenUnwrap(window.one.registry.getConfig()),
  })
}

export function useSaveRegistryConfig() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (cfg: RegistryConfig) => thenUnwrap(window.one.registry.saveConfig(cfg)),
    onSuccess: (saved) => {
      qc.setQueryData(['registry', 'config'], saved)
      // 源/repo 已换，旧索引与 manifest 缓存全部作废
      qc.invalidateQueries({ queryKey: ['registry', 'index'] })
      qc.invalidateQueries({ queryKey: ['registry', 'manifest'] })
    },
  })
}

export function useRegistryIndex() {
  return useQuery({
    queryKey: ['registry', 'index'],
    queryFn: () => thenUnwrap(window.one.registry.getIndex()),
    retry: 1,
  })
}

export function useRegistryManifest(kind?: RegistryAssetKind, id?: string) {
  return useQuery({
    queryKey: ['registry', 'manifest', kind, id],
    queryFn: () => thenUnwrap(window.one.registry.getManifest(kind!, id!)),
    enabled: !!kind && !!id,
    retry: 1,
  })
}

/** 强制刷新索引（绕过主进程 10 分钟内存缓存），结果直接写回 query 缓存 */
export function useRefreshRegistryIndex() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => thenUnwrap(window.one.registry.getIndex(true)),
    onSuccess: (data) => qc.setQueryData(['registry', 'index'], data),
  })
}

/** 仓库 star/fork 统计（失败静默——仅展示用，不阻断浏览） */
export function useRegistryRepoStats() {
  return useQuery({
    queryKey: ['registry', 'repoStats'],
    queryFn: () => thenUnwrap(window.one.registry.getRepoStats()),
    staleTime: 10 * 60 * 1000,
    retry: 0,
  })
}

export function usePlanRegistryImport() {
  return useMutation({
    mutationFn: (input: { kind: RegistryAssetKind; id: string }) =>
      thenUnwrap(window.one.registry.planImport(input)),
  })
}

export function useApplyRegistryImport() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { kind: RegistryAssetKind; id: string; materializeAgents?: boolean }) =>
      thenUnwrap(window.one.registry.applyImport(input)),
    onSuccess: () => {
      // 导入会级联写三类本地资产，全部失效刷新（已安装/有更新态依赖这些列表）
      qc.invalidateQueries({ queryKey: ['agents'] })
      qc.invalidateQueries({ queryKey: ['skills'] })
      qc.invalidateQueries({ queryKey: ['capabilities'] })
    },
  })
}

export function usePlanRegistryExport() {
  return useMutation({
    mutationFn: (input: { kind: RegistryAssetKind; localId: string }) =>
      thenUnwrap(window.one.registry.planExport(input)),
  })
}

export function useApplyRegistryExport() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (items: RegistryExportConfirmItem[]) =>
      thenUnwrap(window.one.registry.applyExport(items)),
    onSuccess: (result) => {
      // 导出成功回写 provenance，刷新列表让「已安装/有更新」徽标立即生效
      if (result) {
        qc.invalidateQueries({ queryKey: ['agents'] })
        qc.invalidateQueries({ queryKey: ['skills'] })
        qc.invalidateQueries({ queryKey: ['capabilities'] })
      }
    },
  })
}

export type { RegistryAssetKind }

// —— 选题库（docs/CONTENT_PIPELINE_PLAN.md §2.3）——
export function useTopics(opts?: {
  status?: Topic['status']
  direction?: string
}) {
  return useQuery({
    queryKey: ['topics', opts],
    queryFn: () => thenUnwrap(window.one.topics.list(opts)),
  })
}

export function useTopic(id?: string) {
  return useQuery({
    queryKey: ['topic', id],
    queryFn: () => thenUnwrap(window.one.topics.get(id!)),
    enabled: !!id,
  })
}

export function useCreateTopic() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Parameters<typeof window.one.topics.create>[0]) =>
      thenUnwrap(window.one.topics.create(input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['topics'] }),
  })
}

export function useUpdateTopic() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Topic> }) =>
      thenUnwrap(window.one.topics.update(id, patch)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['topics'] })
      qc.invalidateQueries({ queryKey: ['topic'] })
    },
  })
}

export function useRemoveTopic() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => thenUnwrap(window.one.topics.remove(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['topics'] }),
  })
}

// —— Review 档案 ——
export function useReviews(opts?: { assetType?: string; assetId?: string }) {
  return useQuery({
    queryKey: ['reviews', opts],
    queryFn: () => thenUnwrap(window.one.reviews.list(opts)),
  })
}

export function useReview(id?: string) {
  return useQuery({
    queryKey: ['review', id],
    queryFn: () => thenUnwrap(window.one.reviews.get(id!)),
    enabled: !!id,
  })
}

export function useCreateReview() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Parameters<typeof window.one.reviews.create>[0]) =>
      thenUnwrap(window.one.reviews.create(input)),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['reviews'] })
      qc.invalidateQueries({
        queryKey: ['reviews', { assetType: vars.assetType, assetId: vars.assetId }],
      })
    },
  })
}

export function useLatestReview(assetType?: string, assetId?: string) {
  return useQuery({
    queryKey: ['review-latest', assetType, assetId],
    queryFn: () => thenUnwrap(window.one.reviews.latestForAsset(assetType!, assetId!)),
    enabled: !!assetType && !!assetId,
  })
}

export function useRemoveReview() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => thenUnwrap(window.one.reviews.remove(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reviews'] }),
  })
}

// —— 风格画像 ——
export function useStyleProfiles() {
  return useQuery({
    queryKey: ['styleProfiles'],
    queryFn: () => thenUnwrap(window.one.styleProfiles.list()),
  })
}

export function useStyleProfile(id?: string) {
  return useQuery({
    queryKey: ['styleProfile', id],
    queryFn: () => thenUnwrap(window.one.styleProfiles.get(id!)),
    enabled: !!id,
  })
}

export function useSaveStyleProfile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Parameters<typeof window.one.styleProfiles.save>[0]) =>
      thenUnwrap(window.one.styleProfiles.save(input)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['styleProfiles'] })
      qc.invalidateQueries({ queryKey: ['styleProfile'] })
    },
  })
}

export function useRemoveStyleProfile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => thenUnwrap(window.one.styleProfiles.remove(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['styleProfiles'] }),
  })
}

// —— 样文 ——
export function useSampleArticles() {
  return useQuery({
    queryKey: ['sampleArticles'],
    queryFn: () => thenUnwrap(window.one.sampleArticles.list()),
  })
}

export function useSampleArticle(id?: string) {
  return useQuery({
    queryKey: ['sampleArticle', id],
    queryFn: () => thenUnwrap(window.one.sampleArticles.get(id!)),
    enabled: !!id,
  })
}

export function useSaveSampleArticle() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Parameters<typeof window.one.sampleArticles.save>[0]) =>
      thenUnwrap(window.one.sampleArticles.save(input)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sampleArticles'] })
      qc.invalidateQueries({ queryKey: ['sampleArticle'] })
    },
  })
}

export function useRemoveSampleArticle() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => thenUnwrap(window.one.sampleArticles.remove(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sampleArticles'] }),
  })
}

export type { ReviewRecord, SampleArticle, StyleProfile, Topic }
