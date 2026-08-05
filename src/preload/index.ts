import { contextBridge, ipcRenderer } from 'electron'
import type {
  Agent,
  Capability,
  IpcResult,
  LLMConfig,
  McpServerConfig,
  McpServerStatus,
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
    /** 启动分段埋点 → userData/logs/startup.log（诊断用，失败不抛） */
    startupMark: (payload: {
      phase: string
      rendererT?: number
      detail?: Record<string, unknown>
    }) => Promise<IpcResult<void>>
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
    pickFile: () => Promise<IpcResult<{ name: string; description?: string; content: string; discipline?: string; scriptPath?: string } | null>>
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
    /** 作答 ask_user 提问（HITL 提问卡提交；home 组队运行也走本通道，同一应答队列） */
    respond: (input: { requestId: string; response: string }) => Promise<IpcResult<void>>
  }
  registry: {
    getConfig: () => Promise<IpcResult<import('@shared/types').RegistryConfig>>
    /** 设置页保存源/repo 配置（主进程校验 + 缓存失效），返回生效配置 */
    saveConfig: (cfg: import('@shared/types').RegistryConfig) => Promise<IpcResult<import('@shared/types').RegistryConfig>>
    /** force=true 绕过 10 分钟内存缓存强制刷新 */
    getIndex: (force?: boolean) => Promise<IpcResult<{ index: import('@shared/types').RegistryIndex; stale: boolean }>>
    getManifest: (kind: import('@shared/types').RegistryAssetKind, id: string) => Promise<IpcResult<unknown>>
    planImport: (input: { kind: import('@shared/types').RegistryAssetKind; id: string }) => Promise<IpcResult<import('@shared/types').RegistryImportPlan>>
    applyImport: (input: { kind: import('@shared/types').RegistryAssetKind; id: string; materializeAgents?: boolean }) => Promise<IpcResult<import('@shared/types').RegistryImportResult>>
    planExport: (input: { kind: import('@shared/types').RegistryAssetKind; localId: string }) => Promise<IpcResult<import('@shared/types').RegistryExportPlan>>
    /** 弹目录选择器；用户取消返回 null，成功返回落盘目录与文件清单并自动 reveal */
    applyExport: (items: import('@shared/types').RegistryExportConfirmItem[]) => Promise<IpcResult<import('@shared/types').RegistryExportResult | null>>
    /** 打开 Registry 贡献页（fork + 手动 PR 引导） */
    openContribute: () => Promise<IpcResult<void>>
    /** 方式 B：导出目录内容经 GitHub API 自动 fork + 提交 PR（需写权限 Token；成功自动打开 PR 页） */
    submitPr: (input: { dir: string; files: string[]; items: import('@shared/types').RegistryExportConfirmItem[] }) => Promise<IpcResult<{ prUrl: string; prNumber: number; reused?: boolean }>>
    /** 仓库 star/fork 统计（匿名 60/h 配额，有 token 自动附带） */
    getRepoStats: () => Promise<IpcResult<{ stars: number; forks: number }>>
  }
  mcp: {
    listServers: () => Promise<IpcResult<McpServerStatus[]>>
    addServer: (input: Omit<McpServerConfig, 'id'>) => Promise<IpcResult<McpServerConfig>>
    updateServer: (input: { id: string } & Partial<Omit<McpServerConfig, 'id'>>) => Promise<IpcResult<McpServerConfig | null>>
    removeServer: (id: string) => Promise<IpcResult<boolean>>
    connectServer: (id: string) => Promise<IpcResult<{ toolCount: number }>>
    disconnectServer: (id: string) => Promise<IpcResult<void>>
    testServer: (input: Omit<McpServerConfig, 'id'>) => Promise<IpcResult<{ toolCount: number; tools: Array<{ name: string; description?: string }> }>>
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
    startupMark: (payload) => ipcRenderer.invoke('system:startupMark', payload),
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
    respond: (input) => ipcRenderer.invoke('orchestrate:respond', input),
  },
  registry: {
    getConfig: () => ipcRenderer.invoke('registry:getConfig'),
    saveConfig: (cfg) => ipcRenderer.invoke('registry:saveConfig', cfg),
    getIndex: (force) => ipcRenderer.invoke('registry:getIndex', force),
    getManifest: (kind, id) => ipcRenderer.invoke('registry:getManifest', kind, id),
    planImport: (input) => ipcRenderer.invoke('registry:planImport', input),
    applyImport: (input) => ipcRenderer.invoke('registry:applyImport', input),
    planExport: (input) => ipcRenderer.invoke('registry:planExport', input),
    applyExport: (items) => ipcRenderer.invoke('registry:applyExport', items),
    openContribute: () => ipcRenderer.invoke('registry:openContribute'),
    submitPr: (input) => ipcRenderer.invoke('registry:submitPr', input),
    getRepoStats: () => ipcRenderer.invoke('registry:getRepoStats'),
  },
  mcp: {
    listServers: () => ipcRenderer.invoke('mcp:listServers'),
    addServer: (input) => ipcRenderer.invoke('mcp:addServer', input),
    updateServer: (input) => ipcRenderer.invoke('mcp:updateServer', input),
    removeServer: (id) => ipcRenderer.invoke('mcp:removeServer', id),
    connectServer: (id) => ipcRenderer.invoke('mcp:connectServer', id),
    disconnectServer: (id) => ipcRenderer.invoke('mcp:disconnectServer', id),
    testServer: (input) => ipcRenderer.invoke('mcp:testServer', input),
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
