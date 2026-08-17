import { contextBridge, ipcRenderer } from 'electron'
import type {
  Agent,
  Attachment,
  Capability,
  IpcResult,
  LLMConfig,
  McpServerConfig,
  McpServerStatus,
  ModelConfig,
  Persona,
  ReviewRecord,
  SampleArticle,
  Session,
  SessionMessage,
  Skill,
  SkillMeta,
  StyleProfile,
  SystemPingResponse,
  TaskRecord,
  ThemeConfig,
  Topic,
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
    list: () => Promise<IpcResult<SkillMeta[]>>
    get: (id: string) => Promise<IpcResult<Skill | null>>
    save: (input: Partial<Skill> & { name: string; content: string }) => Promise<IpcResult<Skill>>
    remove: (id: string) => Promise<IpcResult<void>>
    pickFile: () => Promise<IpcResult<Skill | null>>
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
    create: (input: { title: string; capabilityId?: string; cwd?: string }) => Promise<IpcResult<Session>>
    addMessage: (input: { sessionId: string; role: 'user' | 'assistant' | 'tool'; content: string; meta?: unknown }) => Promise<IpcResult<SessionMessage>>
    /** 读会话项目根（cwd），无则 null */
    getCwd: (sessionId: string) => Promise<IpcResult<string | null>>
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
    chat: (input: {
      message: string
      sessionId?: string
      /** 项目根绝对路径（写入 sessions.cwd，agent 文件工具 + shell 默认 cwd 用） */
      projectPath?: string
      /** 芯片稳定引用（正文为 @名字；主进程按 id 解析） */
      mentions?: Array<{ kind: 'agent' | 'capability' | 'skill'; id: string }>
      /** 用户附件（图片/文件/文件夹） */
      attachments?: Attachment[]
    }) => Promise<IpcResult<{ runId: string }>>
    onStream: (cb: (delta: import('@shared/types').HomeStreamEvent) => void) => () => void
    cancel: (input?: { sessionId?: string }) => Promise<IpcResult<void>>
    confirmCreate: (input: {
      draftId: string
      kind: import('@shared/types').CreateDraft['kind']
      payload: import('@shared/types').CreateDraft['payload']
    }) => Promise<IpcResult<{ id: string }>>
    cancelCreate: (input: { draftId: string }) => Promise<IpcResult<void>>
    /** 未确认创建草稿（按会话重挂确认卡） */
    listPendingDrafts: (input?: { sessionId?: string }) => Promise<IpcResult<import('@shared/types').CreateDraft[]>>
  }
  orchestrate: {
    run: (input: { graph: import('@shared/types').WorkflowGraph; input: string; sessionId?: string; /** 项目根绝对路径（写入 sessions.cwd，agent 文件工具 + shell 默认 cwd 用） */ projectPath?: string }) => Promise<IpcResult<{ runId: string; output: string; stopReason: 'converged' | 'max_supersteps' | 'aborted' }>>
    onStream: (cb: (e: import('@shared/types').StreamEvent) => void) => () => void
    cancel: (input?: { sessionId?: string }) => Promise<IpcResult<void>>
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
  topics: {
    list: (opts?: { status?: Topic['status']; direction?: string; userId?: string }) => Promise<IpcResult<Topic[]>>
    get: (id: string) => Promise<IpcResult<Topic | null>>
    create: (input: Partial<Topic> & { direction: string; title: string }) => Promise<IpcResult<Topic>>
    update: (id: string, patch: Partial<Topic>) => Promise<IpcResult<Topic | null>>
    remove: (id: string) => Promise<IpcResult<void>>
  }
  reviews: {
    list: (opts?: { assetType?: string; assetId?: string; userId?: string }) => Promise<IpcResult<ReviewRecord[]>>
    get: (id: string) => Promise<IpcResult<ReviewRecord | null>>
    create: (input: {
      assetType: string
      assetId: string
      score: number
      verdict: '可发' | '需返工' | '推倒重写'
      userId?: string
      notes?: import('@shared/types').ReviewNotes
    }) => Promise<IpcResult<ReviewRecord>>
    latestForAsset: (assetType: string, assetId: string) => Promise<IpcResult<ReviewRecord | null>>
    remove: (id: string) => Promise<IpcResult<void>>
  }
  styleProfiles: {
    list: () => Promise<IpcResult<StyleProfile[]>>
    get: (id: string) => Promise<IpcResult<StyleProfile | null>>
    save: (input: Partial<StyleProfile> & { name: string }) => Promise<IpcResult<StyleProfile>>
    remove: (id: string) => Promise<IpcResult<void>>
  }
  sampleArticles: {
    list: () => Promise<IpcResult<SampleArticle[]>>
    get: (id: string) => Promise<IpcResult<SampleArticle | null>>
    save: (input: Partial<SampleArticle> & { id?: string; name: string; content: string }) => Promise<IpcResult<SampleArticle>>
    remove: (id: string) => Promise<IpcResult<void>>
  }
  app: {
    setAutoLaunch: (on: boolean) => Promise<IpcResult<boolean>>
    getAutoLaunch: () => Promise<IpcResult<boolean>>
    notify: (input: { title: string; body: string }) => Promise<IpcResult<void>>
    getSystemColorMode: () => Promise<IpcResult<'light' | 'dark' | 'system'>>
    show: () => Promise<IpcResult<void>>
    /** 选择项目目录（openDirectory） */
    pickDirectory: () => Promise<IpcResult<string | null>>
    /** 选择附件（image/file/folder），返回带内容的 Attachment */
    selectAttachment: (type: 'image' | 'file' | 'folder') => Promise<IpcResult<Attachment | null>>
    /** 崩溃恢复：订阅主进程推送的草稿列表（preload 缓存，晚订阅不丢） */
    onCrashRecovery: (cb: (payload: { drafts: Array<{ name: string; content: string }> }) => void) => () => void
    /** 崩溃恢复：拉取当前草稿（mount 时 pull，防 push 竞态） */
    listDrafts: () => Promise<IpcResult<Array<{ name: string; content: string }>>>
    /** 崩溃恢复：上次是否异常退出（弹窗据此过滤，正常退出不弹） */
    hadCrashedLastRun: () => Promise<IpcResult<boolean>>
    /** 崩溃恢复：debounce 写盘 */
    writeDraft: (input: { name: string; content: string }) => Promise<IpcResult<void>>
    /** 崩溃恢复：删除指定草稿 */
    removeDraft: (name: string) => Promise<IpcResult<void>>
  }
  updater: {
    /** 手动检查更新（设置页按钮）；dev 环境返回 available=false */
    check: () => Promise<IpcResult<{ available: boolean; version?: string }>>
    /** 下载并退出安装 */
    downloadAndInstall: () => Promise<IpcResult<void>>
    /** 后台检查发现新版本时触发（启动后 15s + 每 4h 定时检查） */
    onUpdateAvailable: (cb: (info: { version: string }) => void) => () => void
    /** 更新已下载完成，退出后自动安装 */
    onUpdateDownloaded: (cb: (info: { version: string }) => void) => () => void
  }
}

/** 启动早期缓存 crashRecovery，避免 React 订阅前事件丢失 */
let cachedCrashRecovery: { drafts: Array<{ name: string; content: string }> } | null = null
ipcRenderer.on('app:crashRecovery', (_e, payload: { drafts: Array<{ name: string; content: string }> }) => {
  cachedCrashRecovery = payload
})

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
    getCwd: (sessionId) => ipcRenderer.invoke('sessions:getCwd', sessionId),
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
    cancel: (input) => ipcRenderer.invoke('home:cancel', input),
    confirmCreate: (input) => ipcRenderer.invoke('home:confirmCreate', input),
    cancelCreate: (input) => ipcRenderer.invoke('home:cancelCreate', input),
    listPendingDrafts: (input) => ipcRenderer.invoke('home:listPendingDrafts', input),
  },
  orchestrate: {
    run: (input) => ipcRenderer.invoke('orchestrate:run', input),
    onStream: (cb) => {
      const handler = (_e: unknown, event: import('@shared/types').StreamEvent) => cb(event)
      ipcRenderer.on('orchestrate:stream', handler)
      return () => ipcRenderer.off('orchestrate:stream', handler)
    },
    cancel: (input?: { sessionId?: string }) => ipcRenderer.invoke('orchestrate:cancel', input),
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
  topics: {
    list: (opts) => ipcRenderer.invoke('topics:list', opts),
    get: (id) => ipcRenderer.invoke('topics:get', id),
    create: (input) => ipcRenderer.invoke('topics:create', input),
    update: (id, patch) => ipcRenderer.invoke('topics:update', { id, patch }),
    remove: (id) => ipcRenderer.invoke('topics:remove', id),
  },
  reviews: {
    list: (opts) => ipcRenderer.invoke('reviews:list', opts),
    get: (id) => ipcRenderer.invoke('reviews:get', id),
    create: (input) => ipcRenderer.invoke('reviews:create', input),
    latestForAsset: (assetType, assetId) =>
      ipcRenderer.invoke('reviews:latestForAsset', { assetType, assetId }),
    remove: (id) => ipcRenderer.invoke('reviews:remove', id),
  },
  styleProfiles: {
    list: () => ipcRenderer.invoke('styleProfiles:list'),
    get: (id) => ipcRenderer.invoke('styleProfiles:get', id),
    save: (input) => ipcRenderer.invoke('styleProfiles:save', input),
    remove: (id) => ipcRenderer.invoke('styleProfiles:remove', id),
  },
  sampleArticles: {
    list: () => ipcRenderer.invoke('sampleArticles:list'),
    get: (id) => ipcRenderer.invoke('sampleArticles:get', id),
    save: (input) => ipcRenderer.invoke('sampleArticles:save', input),
    remove: (id) => ipcRenderer.invoke('sampleArticles:remove', id),
  },
  app: {
    setAutoLaunch: (on) => ipcRenderer.invoke('app:setAutoLaunch', on),
    getAutoLaunch: () => ipcRenderer.invoke('app:getAutoLaunch'),
    notify: (input) => ipcRenderer.invoke('app:notify', input),
    getSystemColorMode: () => ipcRenderer.invoke('app:getSystemColorMode'),
    show: () => ipcRenderer.invoke('app:show'),
    pickDirectory: () => ipcRenderer.invoke('app:pickDirectory'),
    selectAttachment: (type) => ipcRenderer.invoke('app:selectAttachment', type),
    onCrashRecovery: (cb) => {
      if (cachedCrashRecovery && cachedCrashRecovery.drafts.length > 0) {
        // 同步回放：订阅时主进程事件可能已发过
        queueMicrotask(() => cb(cachedCrashRecovery!))
      }
      const handler = (_e: unknown, payload: { drafts: Array<{ name: string; content: string }> }) => {
        cachedCrashRecovery = payload
        cb(payload)
      }
      ipcRenderer.on('app:crashRecovery', handler)
      return () => ipcRenderer.off('app:crashRecovery', handler)
    },
    listDrafts: () => ipcRenderer.invoke('app:listDrafts'),
    hadCrashedLastRun: () => ipcRenderer.invoke('app:hadCrashedLastRun'),
    writeDraft: (input) => ipcRenderer.invoke('app:writeDraft', input),
    removeDraft: (name) => ipcRenderer.invoke('app:removeDraft', name),
  },
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    downloadAndInstall: () => ipcRenderer.invoke('updater:downloadAndInstall'),
    onUpdateAvailable: (cb) => {
      const handler = (_e: unknown, info: { version: string }) => cb(info)
      ipcRenderer.on('updater:updateAvailable', handler)
      return () => ipcRenderer.off('updater:updateAvailable', handler)
    },
    onUpdateDownloaded: (cb) => {
      const handler = (_e: unknown, info: { version: string }) => cb(info)
      ipcRenderer.on('updater:updateDownloaded', handler)
      return () => ipcRenderer.off('updater:updateDownloaded', handler)
    },
  },
}

contextBridge.exposeInMainWorld('one', api)
