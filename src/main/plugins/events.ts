// —— 插件类型化事件总线（docs/PLUGIN_ARCHITECTURE.md §3 PluginHost.events）——
// App 内实时投影，独立于 run_events 持久层（后者负责回放）。
// 此模块零依赖，是依赖图的叶子节点——registry / host 都引它，它不引任何人。

import { logger } from '../logger'

export type Unsubscribe = () => void

/**
 * 插件可订阅的运行事实 / 生命周期事件载荷。
 * 命名沿用 run_events 的 type 约定（tool.started/completed/failed 与 registry 写盘事实一一对应），
 * 但这里是 App 内实时总线，不落盘、不回放。
 */
export interface PluginEventMap {
  'tool.started': { toolName: string; runId?: string; toolUseId: string; nodeId?: string }
  'tool.completed': {
    toolName: string
    runId?: string
    toolUseId: string
    nodeId?: string
    ms: number
    isError: boolean
    resultLen: number
    attempts: number
  }
  'tool.failed': { toolName: string; runId?: string; toolUseId: string; nodeId?: string; error: string }
  'skill.injected': { agentName: string; skills: string[] }
  /** status:'failed' + reason 用于注册点白名单拒绝的可观测（不塞 run_events，非 per-run） */
  'plugin.registered': { id: string; toolPrefix: string; status?: 'ok' | 'failed'; reason?: string }
  'plugin.unloaded': { id: string; reason: 'disable' | 'uninstall' | 'shutdown' }
}

/** 类型化事件总线：on 返回取消订阅函数，emit 按类型分发带类型的 payload */
class PluginEventBus {
  // 内部用 unknown 存储以规避「映射类型 + 泛型 K 索引」的 TS 限制；
  // 对外 API（on/emit）仍保持 PluginEventMap 的精确类型约束。
  private listeners = new Map<keyof PluginEventMap, Set<(payload: unknown) => void>>()

  on<K extends keyof PluginEventMap>(
    type: K,
    listener: (payload: PluginEventMap[K]) => void,
  ): Unsubscribe {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set<(payload: unknown) => void>()
      this.listeners.set(type, set)
    }
    const wrapped = listener as (payload: unknown) => void
    set.add(wrapped)
    return () => {
      set!.delete(wrapped)
    }
  }

  emit<K extends keyof PluginEventMap>(type: K, payload: PluginEventMap[K]): void {
    const set = this.listeners.get(type)
    if (!set) return
    for (const listener of set) {
      // 订阅者异常不得影响事件源（观测层不打断业务主流程，对齐 runEvents 设计约束）
      try {
        listener(payload)
      } catch (error) {
        logger.error(`[plugin-events] listener for ${String(type)} threw`, error)
      }
    }
  }

  /** 测试 / 卸载时清空全部订阅 */
  clear(): void {
    this.listeners.clear()
  }
}

/** 全局单例事件总线（host 与 registry 共享同一实例） */
export const pluginEvents = new PluginEventBus()
