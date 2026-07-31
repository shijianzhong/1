import { contextBridge, ipcRenderer } from 'electron'
import type {
  Agent,
  Capability,
  IpcResult,
  LLMConfig,
  ModelConfig,
  Persona,
  Session,
  SessionMessage,
  Skill,
  SystemPingResponse,
  TaskRecord,
  ThemeConfig,
} from '@shared/types'

/**
 * window.one.* 命名空间（§八之二 B）。
 * 所有方法返回 Promise<IpcResult<T>>（主进程 withHandler 统一包过），
 * 渲染层用 isIpcFailure() 解包。
 * 流式用 onStream 事件回调（编排引擎阶段接入）。
 */
export interface OneApi {
  system: {
    ping: () => Promise<IpcResult<SystemPingResponse>>
  }
  theme: {
    get: () => Promise<IpcResult<ThemeConfig>>
    set: (theme: ThemeConfig) => Promise<IpcResult<ThemeConfig>>
    pickBackground: () => Promise<IpcResult<{ filePath: string } | null>>
    importBackground: (filePath: string) => Promise<IpcResult<{ imageId: string }>>
    loadBackground: (bg: import('@shared/types').ThemeBackgroundConfig) => Promise<IpcResult<{ dataUrl: string | null; stale?: boolean }>>
    removeBackground: (imageId?: string) => Promise<IpcResult<void>>
  }
  capabilities: {
    list: () => Promise<IpcResult<Capability[]>>
    get: (id: string) => Promise<IpcResult<Capability | null>>
    save: (input: Partial<Capability> & { name: string; graph: Capability['graph'] }) => Promise<IpcResult<Capability>>
    remove: (id: string) => Promise<IpcResult<void>>
  }
  agents: {
    list: () => Promise<IpcResult<Agent[]>>
    get: (id: string) => Promise<IpcResult<Agent | null>>
    save: (input: Partial<Agent> & { name: string; instructions: string }) => Promise<IpcResult<Agent>>
    remove: (id: string) => Promise<IpcResult<void>>
  }
  skills: {
    list: () => Promise<IpcResult<Skill[]>>
    get: (id: string) => Promise<IpcResult<Skill | null>>
    save: (input: Partial<Skill> & { name: string; content: string }) => Promise<IpcResult<Skill>>
    remove: (id: string) => Promise<IpcResult<void>>
    pickFile: () => Promise<IpcResult<{ name: string; description?: string; content: string; scriptPath?: string } | null>>
  }
  models: {
    list: () => Promise<IpcResult<ModelConfig[]>>
    get: (id: string) => Promise<IpcResult<ModelConfig | null>>
    save: (input: Partial<ModelConfig> & { name: string; modelId: string }) => Promise<IpcResult<ModelConfig>>
    remove: (id: string) => Promise<IpcResult<void>>
  }
  providers: {
    list: () => Promise<IpcResult<import('@shared/types').Provider[]>>
    get: (id: string) => Promise<IpcResult<import('@shared/types').Provider | null>>
    save: (input: Partial<import('@shared/types').Provider> & { name: string }) => Promise<IpcResult<import('@shared/types').Provider>>
    remove: (id: string) => Promise<IpcResult<void>>
  }
  persona: {
    get: () => Promise<IpcResult<Persona | null>>
    save: (input: { name: string; instructions: string; modelId?: string }) => Promise<IpcResult<Persona>>
  }
  sessions: {
    list: () => Promise<IpcResult<Session[]>>
    get: (id: string) => Promise<IpcResult<Session | null>>
    remove: (id: string) => Promise<IpcResult<void>>
    rename: (id: string, title: string) => Promise<IpcResult<void>>
    messages: (sessionId: string) => Promise<IpcResult<SessionMessage[]>>
    create: (input: { title: string; capabilityId?: string }) => Promise<IpcResult<Session>>
    addMessage: (input: { sessionId: string; role: 'user' | 'assistant' | 'tool'; content: string; meta?: unknown }) => Promise<IpcResult<SessionMessage>>
  }
  tasks: {
    list: () => Promise<IpcResult<TaskRecord[]>>
    get: (id: string) => Promise<IpcResult<TaskRecord | null>>
    create: (input: { sessionId?: string; capabilityId?: string }) => Promise<IpcResult<TaskRecord>>
  }
  secrets: {
    getLLMConfig: (keyId: string) => Promise<IpcResult<{ baseUrl?: string; defaultModel?: string; hasKey: boolean }>>
    setLLMConfig: (cfg: LLMConfig & { keyId: string }) => Promise<IpcResult<void>>
    removeKey: (keyId: string) => Promise<IpcResult<void>>
    testLLM: (modelId: string) => Promise<IpcResult<{ ok: boolean; error?: string }>>
  }
  home: {
    chat: (input: { message: string; sessionId?: string }) => Promise<IpcResult<{ runId: string }>>
    onStream: (cb: (delta: import('@shared/types').HomeStreamEvent) => void) => () => void
    cancel: () => Promise<IpcResult<void>>
    confirmCreate: (input: {
      draftId: string
      kind: import('@shared/types').CreateDraft['kind']
      payload: import('@shared/types').CreateDraft['payload']
    }) => Promise<IpcResult<{ id: string }>>
    cancelCreate: (input: { draftId: string }) => Promise<IpcResult<void>>
  }
  orchestrate: {
    run: (input: { graph: import('@shared/types').WorkflowGraph; input: string; sessionId?: string }) => Promise<IpcResult<{ runId: string; output: string }>>
    onStream: (cb: (e: import('@shared/types').StreamEvent) => void) => () => void
    cancel: () => Promise<IpcResult<void>>
  }
  app: {
    setAutoLaunch: (on: boolean) => Promise<IpcResult<boolean>>
    getAutoLaunch: () => Promise<IpcResult<boolean>>
    notify: (input: { title: string; body: string }) => Promise<IpcResult<void>>
    getSystemColorMode: () => Promise<IpcResult<'light' | 'dark' | 'system'>>
    show: () => Promise<IpcResult<void>>
  }
}

const api: OneApi = {
  system: {
    ping: () => ipcRenderer.invoke('system:ping'),
  },
  theme: {
    get: () => ipcRenderer.invoke('theme:get'),
    set: (theme) => ipcRenderer.invoke('theme:set', theme),
    pickBackground: () => ipcRenderer.invoke('theme:pickBackground'),
    importBackground: (filePath) => ipcRenderer.invoke('theme:importBackground', filePath),
    loadBackground: (bg) => ipcRenderer.invoke('theme:loadBackground', bg),
    removeBackground: (imageId) => ipcRenderer.invoke('theme:removeBackground', imageId),
  },
  capabilities: {
    list: () => ipcRenderer.invoke('capabilities:list'),
    get: (id) => ipcRenderer.invoke('capabilities:get', id),
    save: (input) => ipcRenderer.invoke('capabilities:save', input),
    remove: (id) => ipcRenderer.invoke('capabilities:remove', id),
  },
  agents: {
    list: () => ipcRenderer.invoke('agents:list'),
    get: (id) => ipcRenderer.invoke('agents:get', id),
    save: (input) => ipcRenderer.invoke('agents:save', input),
    remove: (id) => ipcRenderer.invoke('agents:remove', id),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    get: (id) => ipcRenderer.invoke('skills:get', id),
    save: (input) => ipcRenderer.invoke('skills:save', input),
    remove: (id) => ipcRenderer.invoke('skills:remove', id),
    pickFile: () => ipcRenderer.invoke('skills:pickFile'),
  },
  models: {
    list: () => ipcRenderer.invoke('models:list'),
    get: (id) => ipcRenderer.invoke('models:get', id),
    save: (input) => ipcRenderer.invoke('models:save', input),
    remove: (id) => ipcRenderer.invoke('models:remove', id),
  },
  providers: {
    list: () => ipcRenderer.invoke('providers:list'),
    get: (id) => ipcRenderer.invoke('providers:get', id),
    save: (input) => ipcRenderer.invoke('providers:save', input),
    remove: (id) => ipcRenderer.invoke('providers:remove', id),
  },
  persona: {
    get: () => ipcRenderer.invoke('persona:get'),
    save: (input) => ipcRenderer.invoke('persona:save', input),
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    get: (id) => ipcRenderer.invoke('sessions:get', id),
    remove: (id) => ipcRenderer.invoke('sessions:remove', id),
    rename: (id, title) => ipcRenderer.invoke('sessions:rename', id, title),
    messages: (sessionId) => ipcRenderer.invoke('sessions:messages', sessionId),
    create: (input) => ipcRenderer.invoke('sessions:create', input),
    addMessage: (input) => ipcRenderer.invoke('sessions:addMessage', input),
  },
  tasks: {
    list: () => ipcRenderer.invoke('tasks:list'),
    get: (id) => ipcRenderer.invoke('tasks:get', id),
    create: (input) => ipcRenderer.invoke('tasks:create', input),
  },
  secrets: {
    getLLMConfig: (keyId) => ipcRenderer.invoke('secrets:getLLMConfig', keyId),
    setLLMConfig: (cfg) => ipcRenderer.invoke('secrets:setLLMConfig', cfg),
    removeKey: (keyId) => ipcRenderer.invoke('secrets:removeKey', keyId),
    testLLM: (modelId) => ipcRenderer.invoke('secrets:testLLM', modelId),
  },
  home: {
    chat: (input) => ipcRenderer.invoke('home:chat', input),
    onStream: (cb) => {
      const handler = (_e: unknown, delta: import('@shared/types').HomeStreamEvent) => cb(delta)
      ipcRenderer.on('home:stream', handler)
      return () => ipcRenderer.off('home:stream', handler)
    },
    cancel: () => ipcRenderer.invoke('home:cancel'),
    confirmCreate: (input) => ipcRenderer.invoke('home:confirmCreate', input),
    cancelCreate: (input) => ipcRenderer.invoke('home:cancelCreate', input),
  },
  orchestrate: {
    run: (input) => ipcRenderer.invoke('orchestrate:run', input),
    onStream: (cb) => {
      const handler = (_e: unknown, event: import('@shared/types').StreamEvent) => cb(event)
      ipcRenderer.on('orchestrate:stream', handler)
      return () => ipcRenderer.off('orchestrate:stream', handler)
    },
    cancel: () => ipcRenderer.invoke('orchestrate:cancel'),
  },
  app: {
    setAutoLaunch: (on) => ipcRenderer.invoke('app:setAutoLaunch', on),
    getAutoLaunch: () => ipcRenderer.invoke('app:getAutoLaunch'),
    notify: (input) => ipcRenderer.invoke('app:notify', input),
    getSystemColorMode: () => ipcRenderer.invoke('app:getSystemColorMode'),
    show: () => ipcRenderer.invoke('app:show'),
  },
}

contextBridge.exposeInMainWorld('one', api)
