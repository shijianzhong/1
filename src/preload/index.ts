import { contextBridge, ipcRenderer } from 'electron'
import type {
  IpcResult,
  SystemPingResponse,
  ThemeConfig,
} from '@shared/types'

/**
 * window.one.* 命名空间（§八之二 B）。
 * 所有方法返回 Promise<IpcResult<T>>（主进程 withHandler 统一包过），
 * 流式用 onStream 事件回调（编排引擎阶段接入）。
 */
export interface OneApi {
  system: {
    ping: () => Promise<IpcResult<SystemPingResponse>>
  }
  theme: {
    get: () => Promise<IpcResult<ThemeConfig>>
    set: (theme: ThemeConfig) => Promise<IpcResult<ThemeConfig>>
    // 后续 M6：pickBackground/importBackground/loadBackground/removeBackground
    // onSystemModeChange（渲染层用 matchMedia 监听，主进程 nativeTheme 后续接）
  }
  // —— 编排（M4 接入）——
  // orchestrate: {
  //   run(graph, input, sessionId): Promise<IpcResult<{ runId: string }>>
  //   onStream(cb: (e: StreamEvent) => void): () => void
  //   cancel(runId: string): Promise<IpcResult<void>>
  // }
  // —— 能力/角色/技能/模型/人设/会话/任务/secrets（M1+ 接入）——
}

const api: OneApi = {
  system: {
    ping: () => ipcRenderer.invoke('system:ping'),
  },
  theme: {
    get: () => ipcRenderer.invoke('theme:get'),
    set: (theme) => ipcRenderer.invoke('theme:set', theme),
  },
}

contextBridge.exposeInMainWorld('one', api)
