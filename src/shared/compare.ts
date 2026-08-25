import type { Provider } from './types'

// —— 对比可选模型派生（cc switch 范式：模型以用途挂在 provider 上）——
// 应用没有独立的 ModelConfig 列表 UI，可对比的模型即各 provider 的用途模型
// （primary/reasoning/fast/default）。每一项 id 采用 `${providerId}:${usage}`，
// 作为对比项唯一 key，也是 IPC 回传事件的 modelId，主进程按此解析凭据与模型名。

export interface ComparableModel {
  /** 复合标识 providerId:usage，作为对比项唯一 key，也是 IPC 回传的 modelId */
  id: string
  /** 实际请求的模型名（provider.models[usage]） */
  modelId: string
  /** 展示名：provider 名 · 模型名 */
  name: string
  providerId: string
  usage: string
}

const USAGES = ['primary', 'reasoning', 'fast', 'default'] as const

export function deriveComparableModels(providers: Provider[]): ComparableModel[] {
  return providers.flatMap((p) =>
    USAGES.flatMap((u) => {
      const mid = p.models?.[u]
      if (!mid) return []
      return [{ id: `${p.id}:${u}`, modelId: mid, name: `${p.name} · ${mid}`, providerId: p.id, usage: u }]
    }),
  )
}
