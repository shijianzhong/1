import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { unwrap } from './client'
import type {
  Agent,
  Capability,
  KbAddInput,
  KbAddResult,
  KbDocListItem,
  KbDownloadModelProgressEvent,
  KbProviderPreference,
  KbReindexProgressEvent,
  KbReindexResult,
  KbSearchInput,
  KbSearchResult,
  KbStatus,
  ModelConfig,
  CompareStreamEvent,
  NativeDirDialogLabels,
  NativeFileDialogLabels,
  Persona,
  RegistryAssetKind,
  RegistryConfig,
  RegistryExportConfirmItem,
  ReviewRecord,
  RunInfo,
  RunEventInfo,
  SampleArticle,
  Skill,
  SkillMeta,
  StyleProfile,
  Topic,
} from '@shared/types'
import { deriveComparableModels, type ComparableModel } from '@shared/compare'

// —— TanStack Query hooks（§5.6）——
// 集中管理服务端态（能力/角色/技能/模型列表），缓存与失效。
// IPC 返回 Promise<IpcResult<T>>，.then(unwrap) 解包失败抛 IpcError。

export const thenUnwrap = <T>(p: Promise<{ ok: true; data: T } | { ok: false; code: string; message: string; retryable: boolean }>): Promise<T> =>
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

/** 上传技能包（.zip）→ 解析+保存+资源提取一步到位，返回完整 Skill。labels 为原生对话框文案（i18n） */
export function usePickSkillFile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (labels: NativeFileDialogLabels) => thenUnwrap(window.one.skills.pickFile(labels)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills'] }),
  })
}

// —— 知识库 ——
export function useKbStatus() {
  return useQuery({
    queryKey: ['kb', 'status'],
    queryFn: () => thenUnwrap(window.one.kb.status()),
  })
}

export function useKbDocs() {
  return useQuery({
    queryKey: ['kb', 'docs'],
    queryFn: () => thenUnwrap(window.one.kb.list()),
  })
}

export function useKbAdd() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: KbAddInput) => thenUnwrap(window.one.kb.add(input)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kb', 'docs'] })
      qc.invalidateQueries({ queryKey: ['kb', 'status'] })
    },
  })
}

/** P5：文件摄取——弹框 → 主进程抽取 → ingest；cancel 返 null（留开抽屉不报错）。labels 为原生对话框文案（i18n） */
export function useKbPickFile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (labels: NativeFileDialogLabels) => thenUnwrap(window.one.kb.pickFile(labels)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kb', 'docs'] })
      qc.invalidateQueries({ queryKey: ['kb', 'status'] })
    },
  })
}

export function useKbRemove() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (docId: string) => thenUnwrap(window.one.kb.remove(docId)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kb', 'docs'] })
      qc.invalidateQueries({ queryKey: ['kb', 'status'] })
    },
  })
}

export function useKbSearch() {
  return useMutation({
    mutationFn: (input: KbSearchInput) => thenUnwrap(window.one.kb.search(input)),
  })
}

// —— 知识库 P4：reindex + 模型下载 + provider 偏好 ——

export function useKbReindex() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => thenUnwrap(window.one.kb.reindex()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kb', 'status'] })
      qc.invalidateQueries({ queryKey: ['kb', 'docs'] })
    },
  })
}

export function useKbDownloadModel() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => thenUnwrap(window.one.kb.downloadModel()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kb', 'status'] }),
  })
}

// useKbProviderPreference 已删（review #18 死代码）：provider 下拉读 status.activeProviderId
// 作单一事实源；kb:getProviderPreference IPC 仍在，未来需要时再补 hook。

export function useKbSetProviderPreference() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: KbProviderPreference) =>
      thenUnwrap(window.one.kb.setProviderPreference(input)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kb', 'status'] })
      qc.invalidateQueries({ queryKey: ['kb', 'providerPreference'] })
    },
  })
}

/** 重嵌进度流（webContents.send 单向推，非 TanStack Query；镜像 CrashRecoveryDialog 订阅） */
export function useKbReindexProgress(cb: (ev: KbReindexProgressEvent) => void) {
  useEffect(() => window.one.kb.onReindexProgress(cb), [cb])
}

/** 模型下载进度流 */
export function useKbDownloadModelProgress(cb: (ev: KbDownloadModelProgressEvent) => void) {
  useEffect(() => window.one.kb.onDownloadModelProgress(cb), [cb])
}

// —— 记忆管理页（§三之三 D + 铁律21）——
// 单查询读取三层快照；各 mutation 改完后失效 ['memory'] 触发重拉。
// L1 为 LLM 滚动压缩产物，页面只读+删（不提供编辑），故无 l1:update。

export function useMemory() {
  return useQuery({
    queryKey: ['memory'],
    queryFn: () => thenUnwrap(window.one.memory.list()),
  })
}

export function useMemoryL3Add() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { key: string; value: string }) =>
      thenUnwrap(window.one.memory.l3Add(input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['memory'] }),
  })
}

export function useMemoryL3Update() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { key: string; value: string }) =>
      thenUnwrap(window.one.memory.l3Update(input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['memory'] }),
  })
}

export function useMemoryL3Remove() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { key: string }) => thenUnwrap(window.one.memory.l3Remove(input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['memory'] }),
  })
}

export function useMemoryL2Update() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { sessionId?: string; ts: number; digest: string }) =>
      thenUnwrap(window.one.memory.l2Update(input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['memory'] }),
  })
}

export function useMemoryL2Remove() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { sessionId?: string; ts: number }) =>
      thenUnwrap(window.one.memory.l2Remove(input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['memory'] }),
  })
}

export function useMemoryL1Remove() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { sessionId: string }) => thenUnwrap(window.one.memory.l1Remove(input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['memory'] }),
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
    mutationFn: (input: { items: RegistryExportConfirmItem[]; labels: NativeDirDialogLabels }) =>
      thenUnwrap(window.one.registry.applyExport(input.items, input.labels)),
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

// —— 运行诊断（runs / run_events 事实流）——
export function useRuns(opts?: { sessionId?: string }) {
  return useQuery({
    queryKey: ['runs', opts?.sessionId ?? null],
    queryFn: () =>
      thenUnwrap(
        window.one.runs.list(opts?.sessionId ? { sessionId: opts.sessionId } : undefined),
      ),
  })
}

export function useRunDetail(runId?: string) {
  return useQuery({
    queryKey: ['run', runId],
    queryFn: () => thenUnwrap(window.one.runs.detail({ runId: runId! })),
    enabled: !!runId,
  })
}

export type { ReviewRecord, RunInfo, RunEventInfo, SampleArticle, StyleProfile, Topic }

// —— 定时任务（§定时任务）——
export function useSchedules() {
  return useQuery({
    queryKey: ['schedules'],
    queryFn: () => thenUnwrap(window.one.schedules.list()),
  })
}

export function useCreateSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Parameters<typeof window.one.schedules.create>[0]) =>
      thenUnwrap(window.one.schedules.create(input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules'] }),
  })
}

export function useUpdateSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Parameters<typeof window.one.schedules.update>[0]) =>
      thenUnwrap(window.one.schedules.update(input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules'] }),
  })
}

export function useRemoveSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => thenUnwrap(window.one.schedules.remove(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules'] }),
  })
}

export function useToggleSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      thenUnwrap(window.one.schedules.toggle(input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules'] }),
  })
}

export function useRunScheduleNow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => thenUnwrap(window.one.schedules.runNow(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules'] }),
  })
}

// —— 多模型对比（亮点③）——
// 轻量流式状态：订阅 chat:compare:stream，按 compareId 关联、modelId 归位各路增量。
export interface CompareModelState {
  modelId: string
  modelLabel: string
  text: string
  thinking: string
  status: 'idle' | 'streaming' | 'done' | 'error'
  error?: string
  messageKey?: string
  stopReason?: string | null
  textLen?: number
}

export interface UseCompareResult {
  prompt: string
  setPrompt: (v: string) => void
  system: string
  setSystem: (v: string) => void
  models: ComparableModel[]
  selectedIds: string[]
  toggleModel: (id: string) => void
  running: boolean
  states: Record<string, CompareModelState>
  start: () => void
}

export function useCompare(): UseCompareResult {
  const { data: providers = [] } = useProviders()
  // 对比可选模型从 providers 派生（应用「模型」实为 provider 级，无独立 ModelConfig 列表）
  const models = useMemo(() => deriveComparableModels(providers), [providers])
  const [prompt, setPrompt] = useState('')
  const [system, setSystem] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [states, setStates] = useState<Record<string, CompareModelState>>({})
  const currentCompareId = useRef<string | null>(null)

  useEffect(() => {
    const unsub = window.one.compare.onStream((event: CompareStreamEvent) => {
      if (currentCompareId.current && event.compareId !== currentCompareId.current) return
      switch (event.type) {
        case 'start':
          setStates((prev) => ({
            ...prev,
            [event.modelId]: {
              modelId: event.modelId,
              modelLabel: event.modelLabel,
              text: '',
              thinking: '',
              status: 'streaming',
            },
          }))
          break
        case 'delta':
          setStates((prev) => {
            const s = prev[event.modelId]
            if (!s) return prev
            if (event.delta.type === 'text') {
              return { ...prev, [event.modelId]: { ...s, text: s.text + event.delta.text } }
            }
            if (event.delta.type === 'thinking') {
              return { ...prev, [event.modelId]: { ...s, thinking: s.thinking + event.delta.text } }
            }
            return prev
          })
          break
        case 'done':
          setStates((prev) => {
            const s = prev[event.modelId]
            if (!s) return prev
            return {
              ...prev,
              [event.modelId]: { ...s, status: 'done', stopReason: event.stopReason, textLen: event.textLen },
            }
          })
          break
        case 'error':
          setStates((prev) => {
            const s = prev[event.modelId]
            if (!s) return prev
            return {
              ...prev,
              [event.modelId]: { ...s, status: 'error', error: event.error, messageKey: event.messageKey },
            }
          })
          break
        case 'complete':
          setRunning(false)
          break
      }
    })
    return unsub
  }, [])

  const start = useCallback(() => {
    if (!prompt.trim() || selectedIds.length === 0) return
    setRunning(true)
    setStates({})
    void window.one.compare
      .run({ prompt, modelIds: selectedIds, system: system || undefined })
      .then((res) => {
        if (res.ok) currentCompareId.current = res.data.compareId
        else setRunning(false)
      })
  }, [prompt, selectedIds, system])

  const toggleModel = useCallback((id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }, [])

  return {
    prompt,
    setPrompt,
    system,
    setSystem,
    models,
    selectedIds,
    toggleModel,
    running,
    states,
    start,
  }
}
