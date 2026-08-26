// —— PluginHost 薄壳（docs/PLUGIN_ARCHITECTURE.md §5 Stage 1）——
// 包住现有 tools/registry + 类型化事件总线，作为插件的稳定能力句柄。
// 不引入第三方 IoC，不改底层调用（回归零）：builtin 仍走 registerTool，
// 只是多一层只读代理 + 把 run 事实投影到 events 总线。

import {
  registerTool,
  unregisterByPrefix,
  listToolDefs,
  type ToolDef,
} from '../tools/registry'
import { pluginEvents } from './events'
import type { PluginHost, PluginHandle, PluginToolSpec } from './contracts'

class PluginHostImpl implements PluginHost {
  tools = {
    register(spec: PluginToolSpec): PluginHandle {
      registerTool(
        spec.name,
        spec.description,
        spec.params,
        spec.handler,
        spec.approvalMode ?? 'auto',
        spec.options,
      )
      return {
        name: spec.name,
        unregister: () => {
          unregisterByPrefix(spec.name)
        },
      }
    },
    unregister(prefix: string): number {
      return unregisterByPrefix(prefix)
    },
    list(): ToolDef[] {
      return listToolDefs()
    },
  }

  // 直接复用全局单例总线（与 registry 写盘处 emit 的是同一实例）
  events = pluginEvents
}

/** 全局单例 host 句柄（host 能力本应跨运行稳定单例，与 pluginEvents 同设）；SkillContextProvider 仍 per-run new，经构造参数注入此句柄，不把 SkillContextProvider 自身做成单例 */
export const pluginHost: PluginHost = new PluginHostImpl()
