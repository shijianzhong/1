// —— 插件能力统一契约（docs/PLUGIN_ARCHITECTURE.md §3）——
// 类型 only，无运行时代码；落地实现见 ./host.ts，事件载荷见 ./events.ts。
// 复用 registry 既有类型作为单一事实源（不另造一份工具/上下文类型，避免双份维护）。

import type { ZodTypeAny } from 'zod'
import type {
  RegisterToolOptions,
  ToolApprovalMode,
  ToolContext,
  ToolDef,
} from '../tools/registry'
import type { PluginEventMap, Unsubscribe } from './events'

/** 插件种类（决定插件在哪个具体域生效 + 安全模型） */
export type PluginKind = 'builtin' | 'mcp' | 'skill' | 'generated' | 'external'

/** manifest.source 取值：记录「从哪分发来」，不重复 kind 语义（kind 决定域，source 只记来源） */
export type PluginSource = 'builtin' | 'mcp' | 'skill' | 'registry' | 'external'

/** 插件清单：统一入口 src/main/plugins/registry.ts 读它做 load/start/stop/unload */
export interface OnePluginManifest {
  /** 全局唯一，命名空间如 'builtin/memory' | 'mcp/server-id' | 'skill/{id}' | 'generated/cad' | 'ext/xxx' */
  id: string
  /** builtin | mcp | skill | generated | external（Registry 资产分发到三种再转 manifest） */
  kind: PluginKind
  name: string
  version: string
  description: string
  enabled: boolean
  /** 分发来源：builtin | mcp | skill | registry | external（kind 决定在哪个域值/安全模型，source 只记录"从哪分发来"） */
  source: PluginSource
  /** 可逆效果描述：注册了什么工具 / 注入了什么上下文 / 占用了什么存储；卸载时按此清单回滚，不留下孤儿注册或残留数据 */
  effects: {
    /** 注册的工具名前缀（供 unregisterByPrefix 清理） */
    tools: string[]
    /** 插件独占的表 / JSON 配置键（卸载时清理） */
    storage: string[]
  }
}

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
}
