import { beforeEach, describe, expect, it, vi } from 'vitest'

// —— 捕获 IPC handler（与 topics.test 同范式）——
const handle = vi.fn()

vi.mock('electron', () => ({
  ipcMain: { handle },
  BrowserWindow: { getAllWindows: () => [] },
}))

vi.mock('../logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// —— 仅 mock 做 I/O / 重依赖的协作者；纯 builder 保持真实以贴近运行时语义 ——
vi.mock('../storage/models', () => ({
  getPersona: () => ({ id: 'home', name: 'p', instructions: '', skillIds: [], profile: '', updatedAt: 0 }),
  getDefaultProvider: vi.fn(() => ({
    id: 'p1', name: 'Anthropic', keyId: 'k', baseUrl: undefined, authHeader: undefined,
    apiFormat: 'anthropic', models: { default: 'm' }, enableThinking: false, isDefault: true, createdAt: 0, updatedAt: 0,
  })),
  resolveProviderCredentials: () => ({ apiKey: 'k', baseURL: undefined, authHeader: undefined, apiFormat: 'anthropic', modelId: 'm', enableThinking: false }),
  listMessages: () => [],
  addMessage: vi.fn(),
  getSession: () => null,
  listAgents: () => [],
  listCapabilities: () => [],
  listSkillMetas: () => [],
  getCapability: () => null,
  countSkills: () => 0,
  getSkill: () => null,
  createSession: vi.fn(),
  findMessageByCreateDraftId: () => null,
  updateMessageMeta: vi.fn(),
  saveAgent: vi.fn(), saveCapability: vi.fn(), saveSkill: vi.fn(), savePersona: vi.fn(),
}))

vi.mock('../storage/sessions', () => ({
  addMessage: vi.fn(),
  createSession: vi.fn(),
  findMessageByCreateDraftId: () => null,
  getSession: () => null,
  listMessages: () => [],
  updateMessageMeta: vi.fn(),
}))

vi.mock('../orchestrator/agent', () => ({
  Agent: class { constructor() {} },
}))

vi.mock('../orchestrator/home', () => ({
  TeamJsonDetector: class { feed() { return null } decide() { return { kind: 'direct' } } },
  buildCreateInstruction: () => '',
  buildKbInstruction: () => '',
  buildMemoryInstruction: () => '',
  buildSkillInstruction: () => '',
  buildRoutingInstruction: () => '',
  buildCapabilityFocusBlock: () => '',
  buildTeamGraph: vi.fn(() => null), // 强制内层 try 抛 graph_build_failed
  createKindFromToolName: () => null,
  inferCreateKind: () => null,
  needsCreateRecovery: () => false,
  proposeToolNameForKind: () => null,
  resolveMentions: vi.fn(() => ({ agents: [{ id: 'a1', name: 'A' }], capabilities: [], skills: [], cleanText: '' })),
  runTeam: vi.fn(),
}))

vi.mock('../skills/provider', () => ({
  SkillContextProvider: class {
    beforeRun() { return { instructions: '', injected: [] } }
    afterRun() {}
  },
}))

vi.mock('../storage/db', () => ({
  getDb: () => ({ prepare: () => ({ run: () => ({}) }) }),
}))

// kb_search 激活指令依赖 chunk 数；此处固定为空库（指令段不注入），与 L2/L1 等空态 mock 一致。
vi.mock('../vector/kb-fts', () => ({ countKbChunks: () => 0 }))

vi.mock('../storage/memory/l0', () => ({ injectL0: (a: string) => a }))
vi.mock('../storage/memory/l1', () => ({
  maybeCompressL1: async () => ({ summary: null, recentWindow: [] }),
  buildL1Messages: () => [],
}))
vi.mock('../storage/memory/l2', () => ({
  buildL2Injection: () => '',
  refineL2: async () => undefined,
}))

vi.mock('../llm/retry', () => ({ getClient: () => ({ stream: async () => ({ content: [] }) }) }))
vi.mock('../llm/thinking', () => ({ resolveThinkingConfig: () => undefined }))
vi.mock('../tools/mcp', () => ({ listToolsForAgents: async () => [] }))
vi.mock('../tools/allowlist', () => ({ filterToolsByAllowlist: (t: unknown[]) => t }))
vi.mock('../tools/builtin/memory', () => ({ listMemoryKeysForPrompt: () => [] }))
vi.mock('../tools/sessionApprovals', () => ({
  resolveApprovalDecision: () => ({ approved: false }),
  rejectionToApprovalReason: () => 'denied',
}))

vi.mock('../orchestrator/userInput', () => ({
  newRequestId: () => 'req_1',
  newRunId: () => 'run_x',
  rejectUserInputsForRun: vi.fn(),
  waitForUserInput: vi.fn(),
}))

vi.mock('../crash-recovery', () => ({
  listDrafts: () => [],
  removeDraft: vi.fn(),
  writeDraft: vi.fn(),
}))

// —— run_events 是本次观测对象：用 spy 断言事件条数与 phase 语义 ——
const startRun = vi.fn()
const endRun = vi.fn()
const setRunRoute = vi.fn()
const appendRunEvent = vi.fn()
vi.mock('../storage/runEvents', () => ({
  startRun: (...a: unknown[]) => startRun(...a),
  endRun: (...a: unknown[]) => endRun(...a),
  setRunRoute: (...a: unknown[]) => setRunRoute(...a),
  appendRunEvent: (...a: unknown[]) => appendRunEvent(...a),
}))

function getHandler() {
  const wrapped = handle.mock.calls.find((c) => c[0] === 'home:chat')?.[1]
  if (typeof wrapped !== 'function') throw new Error('home:chat handler 未注册')
  return wrapped as (e: unknown, input: unknown) => Promise<{ ok: boolean }>
}

function failedEvents() {
  return appendRunEvent.mock.calls.filter((c) => c[1] === 'home.run.failed')
}

beforeEach(() => {
  handle.mockReset()
  startRun.mockClear(); endRun.mockClear(); setRunRoute.mockClear(); appendRunEvent.mockClear()
})

describe('home:chat run_events 失败收口（CODE_REVIEW 双层 try 嵌套回归）', () => {
  it('外层失败（无 provider）：恰好 1 条 home.run.failed，phase=pre_inner_try，无重复', async () => {
    const { getDefaultProvider } = await import('../storage/models')
    vi.mocked(getDefaultProvider).mockReturnValue(null)
    const { registerHomeHandlers } = await import('./home')
    registerHomeHandlers()
    const wrapped = getHandler()

    const result = await wrapped({}, { message: 'hi', sessionId: 's_pre' })

    expect(result.ok).toBe(false) // IpcErrorThrow → withHandler 返回 err
    const failed = failedEvents()
    expect(failed).toHaveLength(1)
    expect((failed[0][2] as { phase?: string }).phase).toBe('pre_inner_try')
    expect(endRun).toHaveBeenCalled()
  })

  it('内层失败（directAgent + 图构建失败）：恰好 1 条 home.run.failed，且无 phase 字段（不误标）', async () => {
    const { getDefaultProvider } = await import('../storage/models')
    vi.mocked(getDefaultProvider).mockReturnValue({
      id: 'p1', name: 'Anthropic', keyId: 'k', baseUrl: undefined, authHeader: undefined,
      apiFormat: 'anthropic', models: { default: 'm' }, enableThinking: false, isDefault: true, createdAt: 0, updatedAt: 0,
    } as never)
    const { registerHomeHandlers } = await import('./home')
    registerHomeHandlers()
    const wrapped = getHandler()

    const result = await wrapped({}, { message: '@A 帮我做点事', sessionId: 's_inner' })

    expect(result.ok).toBe(false) // graph_build_failed → err
    const failed = failedEvents()
    // 关键回归断言：内层 throw 穿透到外层 catch 不得产生第二条 / 误标 phase
    expect(failed).toHaveLength(1)
    expect((failed[0][2] as Record<string, unknown>)).not.toHaveProperty('phase')
    // 路由决策事件应先于失败事件写出（directAgent 分支）
    const routeDecided = appendRunEvent.mock.calls.some((c) => c[1] === 'home.route.decided')
    expect(routeDecided).toBe(true)
  })
})
