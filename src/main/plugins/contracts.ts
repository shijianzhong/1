// —— 插件能力统一契约（docs/PLUGIN_ARCHITECTURE.md §3）——
// 类型 only，无运行时代码；落地实现见 ./host.ts，事件载荷见 ./events.ts。
// 复用 registry 既有类型作为单一事实源（不另造一份工具/上下文类型，避免双份维护）。
// 跨进程数据视图（OnePluginManifest / PluginKind / GeneratedPluginSpec）定义在
// @shared/types，此处 re-export 保持主进程单一 import 点。

import type { ZodTypeAny } from 'zod'
import type {
  RegisterToolOptions,
  ToolApprovalMode,
  ToolContext,
  ToolDef,
} from '../tools/registry'
import type { PluginEventMap, Unsubscribe } from './events'

export type { OnePluginManifest, PluginKind, PluginSource, GeneratedPluginSpec, GeneratedBSpec } from '@shared/types'

/** 工具注册 spec（PluginHost.tools.register 入参）；运行时入参校验用 zod schema */
export interface PluginToolSpec {
  name: string
  description: string
  params: ZodTypeAny
  handler: (args: unknown, ctx: ToolContext) => Promise<unknown> | unknown
  approvalMode?: ToolApprovalMode
  options?: RegisterToolOptions
}

/** register 返回的句柄：持有单工具注销能力（等价于 unregisterByPrefix(name) 的精确版） */
export interface PluginHandle {
  name: string
  unregister: () => void
}

/**
 * 插件生命周期钩子。
 * ⚠️ 仅适用于长生命周期插件（builtin/mcp/skill-host 级），per-run 短命对象（如 SkillContextProvider）不走此接口，
 * 它走构造参数注入 host（见 docs/PLUGIN_ARCHITECTURE.md §3「注入方式定死」）。
 */
export interface PluginLifecycle {
  /** 注册工具/订阅/建表。仅长生命周期插件实现 */
  onLoad(ctx: PluginHost): Promise<void>
  /** 回滚 onLoad 的 effects */
  onUnload(reason: 'disable' | 'uninstall' | 'shutdown'): Promise<void>
  /** 一次真实运行的入口（可选，如长生命周期插件的运行入口；Skill 的 beforeRun 走构造注入，不在此钩子） */
  onStart?(ctx: PluginHost, opts: unknown): Promise<unknown>
  onStop?(): Promise<void>
}

/** 插件专属存储句柄（可选，Stage 2 落定）。只允许插件声明并清理自己的表/JSON；Stage 1 不实现具体 API */
export type PluginStorage = Record<string, never>

/** 统一宿主：包住现有 registry + 事件总线 + 存储，作为插件的稳定能力句柄（跨运行、稳定） */
export interface PluginHost {
  /** 封住对全局 registry 的直接 mutable 操作（只读代理 + 审计） */
  tools: {
    register(spec: PluginToolSpec): PluginHandle
    unregister(prefix: string): number
    list(): ToolDef[]
  }
  /** 类型化事件总线：插件订阅运行事实 / 生命周期（见 PluginEventMap） */
  events: {
    on<K extends keyof PluginEventMap>(
      type: K,
      listener: (payload: PluginEventMap[K]) => void,
    ): Unsubscribe
    emit<K extends keyof PluginEventMap>(type: K, payload: PluginEventMap[K]): void
  }
  /** 只允许插件声明并清理自己的表/JSON（可选 P2+） */
  storage?: PluginStorage
  /** 密钥引用：插件按 vault keyId 取解密明文（主进程，明文不落渲染层，铁律3）；secret 型配置字段经此解析 */
  secrets?: {
    get(keyId: string): Promise<string | null>
  }
}
