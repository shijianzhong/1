import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import type {
  AgentConfig,
  ApiFormat,
  GraphNode,
  LlmToolDef,
  StreamEvent,
  WorkflowGraph,
} from '@shared/types'
import { IpcErrorThrow } from '@shared/types'
import { withHandler } from './handler'
import { buildWorkflow, type BuildDeps } from '../orchestrator/builder'
import { runWorkflow } from '../orchestrator/runner'
import {
  newRequestId,
  newRunId,
  rejectUserInputsForRun,
  resolveUserInput,
  waitForUserInput,
} from '../orchestrator/userInput'
import {
  getSkill,
  getAgent,
  getDefaultProvider,
  resolveProviderCredentials,
  getPersona,
} from '../storage/models'
import { addMessage, getSession } from '../storage/sessions'
import { getDb } from '../storage/db'
import { endRun, startRun, appendRunEvent } from '../storage/runEvents'
import { SkillContextProvider } from '../skills/provider'
import { listToolsForAgents } from '../tools/mcp'
import { filterToolsByAllowlist } from '../tools/allowlist'
import { resolveApprovalDecision, rejectionToApprovalReason } from '../tools/sessionApprovals'
import { resolveThinkingConfig } from '../llm/thinking'
import { buildL2Injection } from '../storage/memory/l2'
import { withOrchestrationMemory } from '../storage/memory/compose'
import type { AgentExecutorOptions } from '../orchestrator/patterns/agent'
import { logger } from '../logger'

// —— 编排 IPC（§5.6 + §八之二 B + §三之三 F）——
// orchestrate:run(graph, input, sessionId) → buildWorkflow → runWorkflow
// → webContents.send('orchestrate:stream', event) 流式推渲染。
// cc switch 范式：凭据 + modelId 从默认 provider 取。

const STREAM_CHANNEL = 'orchestrate:stream'
const DEFAULT_USER_ID = 'local'

/**
 * 按 sessionId 隔离的活跃编排（CODE_AUDIT 断言 5.4：旧实现是模块级单例，
 * Electron 多 BrowserWindow 共享主进程模块实例 → 第二个 orchestrate:run
 * 覆盖第一个的 controller，且 finally 的 `===` 判不等 → 不清空 → 时序隐患）。
 * key = sessionId（无 sessionId 的临时运行用 '__transient' 哨兵）。
 * 多窗口各自有独立 sessionId → 互不顶替；cancel(sid) 精确取消该会话的运行。
 */
interface ActiveRun {
  controller: AbortController
  hitlRunId: string
}
const activeRuns = new Map<string, ActiveRun>()
const TRANSIENT_KEY = '__transient'
const runKey = (sessionId?: string): string => sessionId ?? TRANSIENT_KEY

function getMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

function emitStream(event: StreamEvent): void {
  const win = getMainWindow()
  win?.webContents.send(STREAM_CHANNEL, event)
}

/** 从图节点解析 AgentExecutorOptions
 *  节点 data 内联了 Agent 配置快照（拖入时从全局 Agent 模板快照，之后节点级独立可改）。
 *  不再从全局 Agent 注册表查找，实现编排图自包含。
 *  signal：取消运行贯穿到 agent tool-use 循环与 ask_user 挂起等待。
 */
function makeResolveAgent(
  modelId: string,
  apiKey?: string,
  baseURL?: string,
  authHeader?: string,
  enableThinking?: boolean,
  apiFormat?: ApiFormat,
  signal?: AbortSignal,
  /** R1/R2：builtin + 显式暴露的 MCP 工具快照（一次运行内固定） */
  agentTools: LlmToolDef[] = [],
  /** 会话 id：本会话允许工具审批放行键；编辑器试跑可能为空 */
  sessionId?: string,
  /** HITL 队列 run 作用域 */
  hitlRunId?: string,
  /** 项目根（文件工具/shell 用）；默认从 sessionId 对应 session.cwd 读 */
  workspaceRoot?: string,
  /** run_events 事实流归属（runs 表 id；无 = 节点工具事件不落库） */
  eventsRunId?: string,
): {
  resolveAgent: (node: GraphNode) => AgentExecutorOptions | null
  /** 本运行创建的全部 SkillContextProvider（运行结束统一 afterRun 审计，铁律22） */
  skillProviders: SkillContextProvider[]
} {
  const hitlScope = hitlRunId ?? 'orchestrate_default'
  const effectiveWorkspaceRoot = workspaceRoot ?? (sessionId ? getSession(sessionId)?.cwd : undefined)
  // 编排路径记忆注入（对齐 home 页 §三之三 D）：workflow 内每个 agent 都应看到
  // 用户身份（L0）与跨会话长期摘要（L2），否则编排"失忆"。一次运行只取一次。
  const persona = getPersona()
  const l2Injection = buildL2Injection(DEFAULT_USER_ID)
  // 运行期 skill 缓存：同一次运行内多个节点绑定同一 skill 时只读一次磁盘
  // （每次 run 新建 resolver → 缓存随运行结束丢弃，不会吃到过期内容）
  const skillCache = new Map<string, ReturnType<typeof getSkill>>()
  const getSkillCached = (sid: string): ReturnType<typeof getSkill> => {
    const cached = skillCache.get(sid)
    if (cached !== undefined) return cached
    const skill = getSkill(sid)
    skillCache.set(sid, skill)
    return skill
  }
  const skillProviders: SkillContextProvider[] = []

  const resolveAgent = (node: GraphNode): AgentExecutorOptions | null => {
    const data = node.data as {
      instructions?: string
      description?: string
      skillIds?: string[]
      allowedToolNames?: string[]
      modelId?: string
      temperature?: number
      maxTokens?: number
      outputConstraints?: string
      label?: string
      sourceAgentId?: string
      sourceCapabilityId?: string
      agentId?: string
    }

    // 铁律20：executor_id == 节点 id（runner 按节点 id 路由/查找）。
    // 不能用 data.label（角色显示名）——否则 executors.get(node.id) 找不到 → 空白气泡
    const agentName = node.id

    // —— 向后兼容：旧节点无快照配置时，从全局 Agent 回退读取 ——
    // 优先 sourceAgentId，回退 agentId（旧字段名）
    const refAgentId = data.sourceAgentId ?? data.agentId
    const hasSnapshot = data.instructions != null && data.instructions.length > 0
    const fallbackAgent = (!hasSnapshot && refAgentId) ? getAgent(refAgentId) : null

    // 记忆基座：L2 跨会话摘要接末尾、L0 用户身份块接头（对齐 home.ts:320-326），
    // 再交给 SkillContextProvider.beforeRun 注入 <skill> 块与输出纪律段。
    const agentInstructions = withOrchestrationMemory(
      data.instructions ?? fallbackAgent?.instructions ?? '',
      persona,
      l2Injection,
    )
    const agentDescription = data.description ?? fallbackAgent?.description
    const agentSkillIds = data.skillIds ?? fallbackAgent?.skillIds ?? []
    const agentTemperature = data.temperature ?? fallbackAgent?.temperature
    const agentMaxTokens = data.maxTokens ?? fallbackAgent?.maxTokens ?? 16384
    const agentOutputConstraints = data.outputConstraints ?? fallbackAgent?.outputConstraints
    const agentModelId = data.modelId ?? fallbackAgent?.modelId ?? modelId
    const thinking = resolveThinkingConfig(agentModelId, apiFormat, enableThinking ?? false)

    // —— Skill 注入（铁律22，task 7.4）：SkillContextProvider.beforeRun ——
    // <skill> XML 块（限长 24000 + 脚本清单）+ discipline 输出纪律段拼入 instructions；
    // 脚本执行经全局注册的 skill_run_script 工具（铁律23 async spawn）。
    const skillProvider = new SkillContextProvider(getSkillCached)
    skillProviders.push(skillProvider)
    const { instructions, injected: injectedSkills } = skillProvider.beforeRun({
      agentName,
      skillIds: agentSkillIds,
      instructions: agentInstructions,
    })
    if (injectedSkills.length > 0) {
      // 诊断问题 2：节点命中了哪些 skill（含脚本/纪律标记）
      appendRunEvent(eventsRunId, 'skill.injected', {
        nodeId: node.id,
        skills: injectedSkills,
      }, sessionId)
    }

    // outputConstraints 注入 instructions（运行时才吃得到）
    const finalInstructions = agentOutputConstraints
      ? `${instructions}\n\n【输出约束】\n${agentOutputConstraints}`
      : instructions

    // 资产级工具白名单：节点快照 → 源角色（含有快照时也查源角色白名单）
    let allow = data.allowedToolNames
    if (!allow?.length && refAgentId) {
      allow = getAgent(refAgentId)?.allowedToolNames ?? fallbackAgent?.allowedToolNames
    }
    const nodeTools = filterToolsByAllowlist(agentTools, allow)

    const config: AgentConfig = {
      name: agentName,
      description: agentDescription,
      instructions: finalInstructions,
      modelId: agentModelId,
      tools: nodeTools,
      defaultOptions: { maxTokens: agentMaxTokens, temperature: agentTemperature },
      outputConstraints: agentOutputConstraints,
      thinking,
    }
    return {
      config,
      llmOpts: { apiKey, baseURL, authHeader, apiFormat },
      toolCtx: {
        sessionId,
        workspaceRoot: effectiveWorkspaceRoot,
        signal,
        // run_events 事实流归属（registry/runner 事件落库；nodeId 由 Agent 以 config.name 注入）
        runId: eventsRunId,
        // HITL 提问桥：ask_user → request_info 事件推前端 + 挂起等作答（userInput 队列）
        onAskUser: async ({ question, context }) => {
          const requestId = newRequestId()
          emitStream({ type: 'request_info', request_id: requestId, node_id: node.id, question, context })
          try {
            const answer = await waitForUserInput(requestId, { nodeId: node.id, question }, signal, hitlScope)
            emitStream({ type: 'request_resolved', request_id: requestId, node_id: node.id, response: answer })
            return answer
          } catch (e) {
            // 超时/取消：通知前端卡片定格（空 response = 失效），错误抛回工具侧转错误 JSON
            emitStream({ type: 'request_resolved', request_id: requestId, node_id: node.id, response: '' })
            throw e
          }
        },
        // HITL 工具审批桥：支持本会话允许（sessionId 有值时写入放行表）
        onApprove: async ({ toolName, args }) => {
          const requestId = newRequestId()
          emitStream({ type: 'approval_request', request_id: requestId, node_id: node.id, tool_name: toolName, args })
          try {
            const response = await waitForUserInput(
              requestId,
              { nodeId: node.id, question: `approve ${toolName}` },
              signal,
              hitlScope,
            )
            emitStream({ type: 'approval_resolved', request_id: requestId, node_id: node.id, response })
            return resolveApprovalDecision(response, sessionId, toolName)
          } catch (e) {
            // 超时/取消/被顶替：吞错返回 falsy 带区分 reason（铁律11 不抛 → 不死循环），
            // registry 闸门按 reason 选 errors.tools.approval_timeout/approval_aborted（CODE_AUDIT 断言 5.5）。
            emitStream({ type: 'approval_resolved', request_id: requestId, node_id: node.id, response: '' })
            return { approved: false, reason: rejectionToApprovalReason(e) }
          }
        },
        // update_plan 计划更新桥（Task 6）：推给前端展示计划进度
        onPlanUpdate: (p) => {
          emitStream({
            type: 'plan_update',
            node_id: node.id,
            explanation: p.explanation,
            plan: p.plan,
          })
        },
      },
    }
  }

  return { resolveAgent, skillProviders }
}

export function registerOrchestrateHandlers(): void {
  withHandler<{ runId: string; output: string; stopReason: 'converged' | 'max_supersteps' | 'aborted' }>(
    'orchestrate:run',
    async (_e, input) => {
      const { graph, input: text, sessionId, projectPath } = input as {
        graph: WorkflowGraph
        input: string
        sessionId?: string
        /** 项目根绝对路径（写入 sessions.cwd，agent 文件工具/shell 用） */
        projectPath?: string
      }

      // 项目根持久化（与 home.chat 对齐）：传了就写 sessions.cwd，makeResolveAgent 回读
      if (projectPath) {
        const sid = sessionId
        if (sid) {
          getDb().prepare('UPDATE sessions SET cwd = ?, updated_at = ? WHERE id = ?').run(projectPath, Date.now(), sid)
        }
      }

      const provider = getDefaultProvider()
      if (!provider) {
        throw new IpcErrorThrow('errors:orchestrate.no_provider', '未配置供应商')
      }
      const { apiKey, baseURL, authHeader, modelId, enableThinking, apiFormat } =
        resolveProviderCredentials(provider, 'default')
      if (!modelId) {
        throw new IpcErrorThrow('errors:orchestrate.no_default_model', '供应商未配置默认模型')
      }

      // 先建 AbortController：signal 贯穿 toolCtx（agent 循环 + ask_user 挂起），
      // cancel 才能真正打断「等用户作答」与工具循环（原来只断 superstep 间隙）。
      // 并发防御：同 sessionId 已有运行时先取消旧的（渲染层 running 守卫下不会并发，兜底重复 IPC）。
      // 按 sessionId 隔离：多窗口各持独立会话，互不顶替（断言 5.4）。
      const key = runKey(sessionId)
      const existing = activeRuns.get(key)
      if (existing) {
        logger.warn(`[orchestrate] 会话 ${key} 已有运行中的编排，自动取消旧运行`)
        existing.controller.abort()
        rejectUserInputsForRun(existing.hitlRunId, 'aborted')
      }
      const controller = new AbortController()
      const hitlRunId = newRunId('orch')
      activeRuns.set(key, { controller, hitlRunId })
      const { signal } = controller
      // run_events 事实流：editor 入口 run 登记（与 hitlRunId 是两个概念——
      // 后者是 HITL 队列作用域，前者是诊断事实流归属）
      const eventsRunId = `run_${randomUUID()}`
      startRun({ id: eventsRunId, sessionId, entry: 'editor' })
      // try 覆盖 startRun 之后全部步骤（CODE_REVIEW P0）：原 try 只在 runWorkflow 外，
      // listToolsForAgents/makeResolveAgent/buildWorkflow 抛异常时 run 行卡 'running'。
      // skillProviders 提前声明为 let——finally 在 try 外引用它，避免提前抛异常时
      // finally 的 ReferenceError；try 内一次调用 makeResolveAgent 取值。
      let skillProviders: ReturnType<typeof makeResolveAgent>['skillProviders'] = []
      try {
      const agentTools = await listToolsForAgents()
      const resolved = makeResolveAgent(
        modelId, apiKey, baseURL, authHeader, enableThinking, apiFormat, signal, agentTools, sessionId, hitlRunId,
        projectPath, eventsRunId,
      )
      skillProviders = resolved.skillProviders
      const deps: BuildDeps = { resolveAgent: resolved.resolveAgent }

      const wf = buildWorkflow(graph, deps)

      // 会话持久化（编辑器运行落 session，与首页 @能力 运行对齐）：用户输入 + 聚合输出
      if (sessionId) addMessage({ sessionId, role: 'user', content: text })
        const result = await runWorkflow(wf, { text, sessionId, runId: eventsRunId }, emitStream, signal)
        // abort / max_supersteps 时只落用户输入，不把半截聚合输出当完整 assistant 消息存库
        //（CODE_AUDIT 断言 1.4：abort 被当成功存部分输出）。事件流已发 failed，前端区分。
        endRun(
          eventsRunId,
          result.stopReason === 'converged'
            ? 'completed'
            : result.stopReason === 'aborted'
              ? 'aborted'
              : 'error',
        )
        if (sessionId && result.output && result.stopReason === 'converged') {
          addMessage({ sessionId, role: 'assistant', content: result.output })
        }
        return {
          runId: sessionId ?? `run_${randomUUID().slice(0, 8)}`,
          output: result.output,
          stopReason: result.stopReason,
        }
      } catch (e) {
        // runWorkflow 抛出（LLM 网络异常等）：收口 run 状态再向上抛
        endRun(eventsRunId, signal.aborted ? 'aborted' : 'error')
        throw e
      } finally {
        // 仅驳回本 run 的挂起提问，避免误伤首页 home 通道
        rejectUserInputsForRun(hitlRunId, 'run_finished')
        // SkillContextProvider.afterRun（铁律22）：运行结束审计
        for (const p of skillProviders) p.afterRun()
        // 仅清自己的 entry（=== controller 比对：防被新 run 顶替后误删新 controller）
        const entry = activeRuns.get(key)
        if (entry?.controller === controller) {
          activeRuns.delete(key)
        }
      }
    },
  )

  // 用户作答 ask_user 提问（渲染层提问卡提交）。requestId 全局唯一，
  // home 通道的组队运行也走同一 userInput 队列，故 respond 收口在本通道。
  withHandler<void>('orchestrate:respond', async (_e, input) => {
    const { requestId, response } = input as { requestId: string; response: string }
    if (!requestId || typeof response !== 'string') {
      throw new IpcErrorThrow('errors:orchestrate.missing_params', '参数缺失')
    }
    const found = resolveUserInput(requestId, response)
    if (!found) {
      throw new IpcErrorThrow('errors:orchestrate.request_expired', '提问已失效（超时或已作答）')
    }
  })

  withHandler<void>(
    'orchestrate:cancel',
    async (_e, input) => {
      // 按 sessionId 精确取消该会话的活跃运行（断言 5.4：多窗口隔离）。
      // 无 sessionId 入参 → 取消临时运行（__transient）；这是向后兼容的旧行为。
      const sessionId = (input as { sessionId?: string } | undefined)?.sessionId
      const key = runKey(sessionId)
      const entry = activeRuns.get(key)
      if (entry) {
        rejectUserInputsForRun(entry.hitlRunId, 'aborted')
        entry.controller.abort()
        activeRuns.delete(key)
        logger.info(`[orchestrate] 已取消会话 ${key} 的编排`)
      }
    },
  )
}
