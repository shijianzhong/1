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
    // M6: pickBackground/importBackground/loadBackground/removeBackground
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
  }
  models: {
    list: () => Promise<IpcResult<ModelConfig[]>>
    get: (id: string) => Promise<IpcResult<ModelConfig | null>>
    save: (input: Partial<ModelConfig> & { name: string; modelId: string }) => Promise<IpcResult<ModelConfig>>
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
  // 编排（M4 接入）
  // orchestrate: { run, onStream, cancel }
}

const api: OneApi = {
  system: {
    ping: () => ipcRenderer.invoke('system:ping'),
  },
  theme: {
    get: () => ipcRenderer.invoke('theme:get'),
    set: (theme) => ipcRenderer.invoke('theme:set', theme),
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
  },
  models: {
    list: () => ipcRenderer.invoke('models:list'),
    get: (id) => ipcRenderer.invoke('models:get', id),
    save: (input) => ipcRenderer.invoke('models:save', input),
    remove: (id) => ipcRenderer.invoke('models:remove', id),
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
}

contextBridge.exposeInMainWorld('one', api)
