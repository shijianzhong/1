import { BrowserWindow } from 'electron'
import type {
  AgentConfig,
  CreateDraft,
  CreateMeta,
  HomeStreamEvent,
  LlmMessage,
  Persona,
} from '@shared/types'
import { IpcErrorThrow } from '@shared/types'
import { withHandler } from './handler'
import {
  getDefaultProvider,
  getPersona,
  getSkill,
  getAgent,
  getCapability,
  listAgents,
  listCapabilities,
  listSkills,
  resolveProviderCredentials,
  saveAgent,
  saveCapability,
  saveSkill,
  savePersona,
} from '../storage/models'
import {
  addMessage,
  createSession,
  findMessageByCreateDraftId,
  listMessages,
  updateMessageMeta,
} from '../storage/sessions'
import { Agent } from '../orchestrator/agent'
import {
  TeamJsonDetector,
  buildCreateInstruction,
  buildMemoryInstruction,
  buildRoutingInstruction,
  buildCapabilityFocusBlock,
  buildTeamGraph,
  createKindFromToolName,
  inferCreateKind,
  needsCreateRecovery,
  proposeToolNameForKind,
  resolveMentions,
  runTeam,
  type CreateKind,
} from '../orchestrator/home'
import { SkillContextProvider } from '../skills/provider'
import { injectL0 } from '../storage/memory/l0'
import { buildL1Messages, maybeCompressL1 } from '../storage/memory/l1'
import { buildL2Injection, refineL2 } from '../storage/memory/l2'
import { getClient } from '../llm/retry'
import { resolveThinkingConfig } from '../llm/thinking'
import { listToolsForAgents } from '../tools/mcp'
import { listMemoryKeysForPrompt } from '../tools/builtin/memory'
import { resolveApprovalDecision } from '../tools/sessionApprovals'
import {
  newRequestId,
  rejectAllUserInputs,
  waitForUserInput,
} from '../orchestrator/userInput'
import type { BuildDeps } from '../orchestrator/builder'
import type { AgentExecutorOptions } from '../orchestrator/patterns/agent'
import { logger } from '../logger'

// —— 首页主助手聊天 IPC（§5.6 + §三之三 D/M + 铁律21）——
// 以供应商为中心（cc switch 范式）：key 在 provider 级共享，
// modelId 从 provider.models 按用途取（default 兜底）。
// 三级记忆注入：L0 身份块→instructions；L1 摘要→messages 首条；
//   L2 跨会话摘要→persona 段；L3→工具按需检索。

const STREAM_CHANNEL = 'home:stream'
const DEFAULT_USER_ID = 'local'

/** 当前聊天的 AbortController（home:cancel 用；组队运行内 ask_user 挂起也受它取消） */
let currentAbortController: AbortController | null = null

/** 创建提案草稿暂存（draftId → {draft, ts}）；确认/取消删除，超时（30min）惰性清理。 */
const DRAFT_TTL_MS = 30 * 60 * 1000
/** 草稿驻留硬上限：正常流程单 figure 确认即删到不了上限；防异常 propose 风暴撑内存 */
const MAX_PENDING_DRAFTS = 100
const pendingDrafts = new Map<string, { draft: CreateDraft; ts: number }>()

/** propose_* 工具结果是否表示失败（Zod invalid_args / empty_payload 等） */
function parseProposeFailure(content: string): {
  error: string
  messageKey: string
  detail?: unknown
} | null {
  try {
    const parsed = JSON.parse(content) as {
      ok?: boolean
      error?: string
      messageKey?: string
      detail?: unknown
      hint?: string
    }
    if (parsed.ok === true) return null
    if (!parsed.error && parsed.ok !== false) return null
    const error = parsed.error ?? 'propose_failed'
    const messageKey =
      parsed.messageKey ??
      (error === 'invalid_args'
        ? 'errors.create.invalid_args'
        : error === 'empty_payload'
          ? 'errors.create.empty_payload'
          : 'errors.create.propose_failed')
    return { error, messageKey, detail: parsed.detail ?? parsed.hint }
  } catch {
    return null
  }
}

/** 惰性清理超时草稿（随新提案/确认调用，防用户不点按钮直接离开导致的内存驻留） */
function pruneDrafts(): void {
  const now = Date.now()
  for (const [id, entry] of pendingDrafts) {
    if (now - entry.ts > DRAFT_TTL_MS) pendingDrafts.delete(id)
  }
}

function getMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

function emitStream(delta: HomeStreamEvent): void {
  const win = getMainWindow()
  win?.webContents.send(STREAM_CHANNEL, delta)
}

/** LLM 压缩函数（供 L1/L2 调用，用默认 provider） */
function makeCompressFn(
  modelId: string,
  apiKey?: string,
  baseURL?: string,
  authHeader?: string,
  apiFormat?: import('@shared/types').ApiFormat,
) {
  return async (text: string): Promise<string> => {
    const client = getClient(modelId, { apiKey, baseURL, authHeader, apiFormat })
    const res = await client.stream({
      model: modelId,
      system: '你是摘要助手。把对话压缩成不超过 300 字的要点摘要，保留关键事实与意图。',
      messages: [{ role: 'user', content: text }],
      maxTokens: 1024,
    })
    const block = res.content.find((b) => b.type === 'text')
    return block?.text ?? ''
  }
}

export function registerHomeHandlers(): void {
  withHandler<{ runId: string }>('home:chat', async (_e, input) => {
    const { message, sessionId } = input as { message: string; sessionId?: string }

    // 1. session
    const newSession = sessionId ? undefined : createSession({ title: message.slice(0, 20) })
    const sid = sessionId ?? newSession!.id

    // 2. persona + provider + key（cc switch：从 provider 取凭据 + modelId）
    const persona = getPersona()
    const provider = getDefaultProvider()
    if (!provider) {
      throw new IpcErrorThrow('errors:home.no_provider', '未配置供应商，请先在模型页添加供应商')
    }
    const { apiKey, baseURL, authHeader, modelId, enableThinking, apiFormat } = resolveProviderCredentials(provider, 'default')
    logger.info('[home] provider:', provider.name, 'enableThinking:', enableThinking, 'modelId:', modelId)
    if (!modelId) {
      throw new IpcErrorThrow('errors:home.no_default_model', '供应商未配置默认模型')
    }
    const compressFn = makeCompressFn(modelId, apiKey, baseURL, authHeader, apiFormat)

    // 3. 历史 + 当前消息
    const history = listMessages(sid)
    addMessage({ sessionId: sid, role: 'user', content: message })

    const historyMessages: LlmMessage[] = history.map((m) => ({
      role: m.role === 'tool' ? ('user' as const) : m.role,
      content: m.content,
    }))
    const allMessages: LlmMessage[] = [
      ...historyMessages,
      { role: 'user', content: message },
    ]

    // 4. L1 滚动压缩（超阈值压缩前文，最近窗口保留原文）
    const { summary: _l1Summary, recentWindow } = await maybeCompressL1(
      sid,
      allMessages,
      compressFn,
    )
    void _l1Summary
    const l1Messages = buildL1Messages(sid, recentWindow)

    // 5. 拼装 instructions（§D）：L0 + L2 + persona instructions + skill 注入
    const baseInstructions = persona?.instructions ?? ''
    const l2 = buildL2Injection(DEFAULT_USER_ID)
    const instructionsWithL2 = l2
      ? `${baseInstructions}\n\n${l2}`
      : baseInstructions
    const instructionsWithL0 = injectL0(instructionsWithL2, persona)

    // —— @提及预解析（提前到这里：@skill 要注入 instructions，需在拼 config 前解析）——
    // 角色/能力直跳逻辑在下方 agent 构建后再分流；此处先把 mentions 解出来供 skill 注入用。
    const allAgents = listAgents()
    const allCapabilities = listCapabilities()
    const allSkills = listSkills()
    const mentions = resolveMentions(message, allAgents, allCapabilities, allSkills)

    // —— @提及意图分流（提前判定：决定路由指令形态 + 后续跑图路径）——
    // focusCap：纯 @单能力 → 不直接跑图，改喂主 Agent 聚焦块（介绍能力 or 输出组队 JSON 跑图）。
    // directAgent：纯 @角色 → 直跳跑角色图（问单角色就该它自己答，单调用无并发问题）。
    const focusCap = mentions.capabilities.length === 1 &&
      mentions.agents.length === 0 &&
      mentions.skills.length === 0
      ? getCapability(mentions.capabilities[0].id) ?? null
      : null
    const directAgent = mentions.agents.length >= 1 &&
      mentions.capabilities.length === 0 &&
      mentions.skills.length === 0
      ? mentions.agents
      : null

    // —— Skill 注入（铁律22，task 7.4）：SkillContextProvider.beforeRun ——
    // persona 绑定 skill + @skill 动态注入：<skill> XML 块（限长 24000 + 脚本清单）
    // + discipline 输出纪律段拼入 instructions；缺失 skill 由 provider warn 跳过。
    const skillProviders: SkillContextProvider[] = []
    const personaSkillIds = persona?.skillIds ?? []
    // @skill 与 persona 绑定 skill 去重（同 id 不重复注入）
    const boundIds = new Set(personaSkillIds)
    const mentionSkills = mentions.skills.filter((s) => !boundIds.has(s.id))
    const homeSkillProvider = new SkillContextProvider(
      (sid) => mentionSkills.find((s) => s.id === sid) ?? getSkill(sid),
    )
    skillProviders.push(homeSkillProvider)
    const { instructions: instructionsWithSkills } = homeSkillProvider.beforeRun({
      agentName: 'home',
      skillIds: [...personaSkillIds, ...mentionSkills.map((s) => s.id)],
      instructions: instructionsWithL0,
    })

    // —— 意图路由指令段（§三之三 M + 铁律24）：注入角色/能力清单 + 组队 JSON 约定 ——
    // 主 Agent 据此判断直答 vs 输出组队 JSON；无可用角色/能力时不注入（不打扰人设）。
    // @单能力（focusCap）：改注入能力聚焦块——主 Agent 介绍能力 or 输出组队 JSON 跑图（不直接跑图）。
    const routingInstruction = focusCap
      ? buildCapabilityFocusBlock(focusCap)
      : buildRoutingInstruction(allAgents, allCapabilities)
    const instructionsWithRouting = routingInstruction
      ? `${instructionsWithSkills}\n${routingInstruction}`
      : instructionsWithSkills

    // —— 创建指令段：引导主 Agent 识别创建/修改意图 → 多轮澄清 → propose_* 产出草稿。
    // 注入当前 persona 原文（<persona> 边界），防 LLM 把 L0/记忆/路由段误当人设固化。
    // —— 记忆策略指令段（铁律21 L3 激活）：告诉主 Agent 何时记/何时取，附已有记忆 key 防重复。
    const instructions = `${instructionsWithRouting}\n${buildCreateInstruction(persona)}\n${buildMemoryInstruction(listMemoryKeysForPrompt())}`

    // 取消控制器：贯穿主 Agent 流式 / 组队 runner / ask_user 挂起（home:cancel 生效）。
    // 并发防御：单窗口 + 渲染层 sending 守卫下不会并发，但若发生（重复 IPC 调用），
    // 先取消上一次运行——否则旧运行失去取消句柄成僵尸
    // M6 修复：AbortController 必须在 toolCtx 之前创建——toolCtx 闭包引用 signal，
    // 虽 JS 闭包延迟取值不会报错，但先创建可避免 TDZ 风险 + 代码意图更清晰
    if (currentAbortController) {
      logger.warn('[home] 已有运行中的聊天，自动取消旧运行')
      currentAbortController.abort()
    }
    currentAbortController = new AbortController()
    const { signal } = currentAbortController

    // R1/R2：builtin + 显式 exposeToAgents 且已连接的 MCP 工具（同一快照供主 Agent / 组队节点共用）
    const agentTools = await listToolsForAgents()
    const proposeToolNames = agentTools.filter((t) => t.name.startsWith('propose_')).map((t) => t.name)
    logger.info('[home] propose_* 工具:', proposeToolNames.length ? proposeToolNames.join(',') : '（无！创建链路不可用）')

    // 6. Agent（带 memory 工具：L3 recall/search/retain）
    // thinking：按供应商开关 + 模型类型选择 thinking 参数格式
    // - adaptive：仅 Opus 4.7/4.8/Opus 5 支持
    // - enabled + budget_tokens：Claude 4 系列（Sonnet 4.5 / Opus 4.1 / Haiku 4.5）
    // - 非 anthropic 协议（中转 OpenAI 等）不传 thinking 参数
    const thinking = resolveThinkingConfig(modelId, apiFormat, enableThinking)
    const config: AgentConfig = {
      name: 'home',
      instructions,
      modelId,
      tools: agentTools,
      defaultOptions: { maxTokens: 16384 },
      thinking,
    }
    /** 本回合是否已弹出 propose_* 确认卡（用于幻觉入库补跑） */
    let proposeCount = 0
    /** 用数组承接闭包写入，避免 TS 把 let 收窄成恒 null → never */
    const proposedThisTurn: CreateDraft[] = []
    let lastProposeFailKind: CreateKind | null = null
    let createRecovered = false
    const emitProposeFailure = (toolName: string, content: string): void => {
      const kind = createKindFromToolName(toolName)
      if (!kind) return
      const fail = parseProposeFailure(content)
      if (!fail) return
      lastProposeFailKind = kind
      logger.warn(`[home:create] propose failed: kind=${kind} code=${fail.error}`)
      emitStream({
        type: 'proposal_error',
        kind,
        error: fail.error,
        messageKey: fail.messageKey,
        detail: fail.detail,
      })
    }
    const agent = new Agent(config, {
      llmOpts: { apiKey, baseURL, authHeader, apiFormat },
      toolCtx: {
        sessionId: sid,
        signal,
        // propose_* 工具产出草稿 → 经此桥 emitStream proposal → 前端确认卡（不落库）
        // 打上 sessionId：回合结束清 streamMsgs 后仍可按会话重挂，避免确认卡闪没
        onPropose: (draft) => {
          proposeCount += 1
          pruneDrafts()
          const stamped: CreateDraft = { ...draft, sessionId: sid }
          proposedThisTurn.push(stamped)
          // 超上限挤掉最旧草稿（Map 迭代序即插入序）
          if (pendingDrafts.size >= MAX_PENDING_DRAFTS && !pendingDrafts.has(stamped.draftId)) {
            const oldest = pendingDrafts.keys().next().value
            if (oldest) pendingDrafts.delete(oldest)
          }
          pendingDrafts.set(stamped.draftId, { draft: stamped, ts: Date.now() })
          emitStream({ type: 'proposal', draft: stamped })
          logger.info(`[home:create] propose invoked: kind=${stamped.kind} draftId=${stamped.draftId}`)
        },
        // HITL 提问桥（ask_user 工具）：事件经 orch_event 包装，前端渲染 AskUserCard；
        // respond 收口在 orchestrate:respond（与组队节点同一 userInput 队列）
        onAskUser: async ({ question, context }) => {
          const requestId = newRequestId()
          const emit = (event: import('@shared/types').StreamEvent): void =>
            emitStream({ type: 'orch_event', event })
          emit({ type: 'request_info', request_id: requestId, node_id: 'home', question, context })
          try {
            const answer = await waitForUserInput(requestId, { nodeId: 'home', question }, signal)
            emit({ type: 'request_resolved', request_id: requestId, node_id: 'home', response: answer })
            return answer
          } catch (e) {
            emit({ type: 'request_resolved', request_id: requestId, node_id: 'home', response: '' })
            throw e
          }
        },
        // HITL 工具审批桥（shell_run / MCP always 工具）：approval_request 事件 + 挂起等用户确认
        // 应答 approved / approved_session / denied（本会话允许写入 sessionApprovals）
        onApprove: async ({ toolName, args }) => {
          const requestId = newRequestId()
          const emit = (event: import('@shared/types').StreamEvent): void =>
            emitStream({ type: 'orch_event', event })
          emit({ type: 'approval_request', request_id: requestId, node_id: 'home', tool_name: toolName, args })
          try {
            const response = await waitForUserInput(requestId, { nodeId: 'home', question: `approve ${toolName}` }, signal)
            emit({ type: 'approval_resolved', request_id: requestId, node_id: 'home', response })
            return resolveApprovalDecision(response, sid, toolName)
          } catch (e) {
            emit({ type: 'approval_resolved', request_id: requestId, node_id: 'home', response: '' })
            return { approved: false, reason: 'timeout or cancelled' }
          }
        },
      },
    })

    // —— 编排图 BuildDeps（组队/能力直跑共用）——
    const buildDeps: BuildDeps = {
      resolveAgent: (node) => {
        const d = node.data as {
          label?: string
          instructions?: string
          description?: string
          skillIds?: string[]
          modelId?: string
          temperature?: number
          maxTokens?: number
          outputConstraints?: string
        }
        const nodeThinking = resolveThinkingConfig(
          d.modelId ?? modelId,
          apiFormat,
          enableThinking,
        )
        // —— Skill 注入（铁律22，task 7.4）：组队图节点经 SkillContextProvider 注入 ——
        // （此前首页组队节点完全没注入 skill，与编辑器编排行为不齐）
        const nodeSkillProvider = new SkillContextProvider((sid) => getSkill(sid))
        skillProviders.push(nodeSkillProvider)
        const { instructions: nodeInstructions } = nodeSkillProvider.beforeRun({
          agentName: node.id,
          skillIds: d.skillIds ?? [],
          instructions: d.instructions ?? '',
        })
        // outputConstraints 注入 instructions（与编辑器编排对齐，运行时才吃得到）
        const finalNodeInstructions = d.outputConstraints
          ? `${nodeInstructions}\n\n【输出约束】\n${d.outputConstraints}`
          : nodeInstructions
        const cfg: AgentConfig = {
          // 铁律20：executor_id == 节点 id（runner 按节点 id 路由/查找），
          // 不能用 d.label（角色显示名）——否则 executors.get(node.id) 找不到 → 空白气泡
          name: node.id,
          description: d.description,
          instructions: finalNodeInstructions,
          modelId: d.modelId ?? modelId,
          tools: agentTools,
          defaultOptions: { maxTokens: d.maxTokens ?? 16384, temperature: d.temperature },
          outputConstraints: d.outputConstraints,
          thinking: nodeThinking,
        }
        const opts: AgentExecutorOptions = {
          config: cfg,
          llmOpts: { apiKey, baseURL, authHeader },
          toolCtx: {
            sessionId: sid,
            signal,
            // HITL 提问桥：事件经 orch_event 包装（与 runTeam 的流式事件同路），
            // respond 收口在 orchestrate:respond（同一 userInput 队列）
            onAskUser: async ({ question, context }) => {
              const requestId = newRequestId()
              const emit = (event: import('@shared/types').StreamEvent): void =>
                emitStream({ type: 'orch_event', event })
              emit({ type: 'request_info', request_id: requestId, node_id: node.id, question, context })
              try {
                const answer = await waitForUserInput(requestId, { nodeId: node.id, question }, signal)
                emit({ type: 'request_resolved', request_id: requestId, node_id: node.id, response: answer })
                return answer
              } catch (e) {
                emit({ type: 'request_resolved', request_id: requestId, node_id: node.id, response: '' })
                throw e
              }
            },
            // HITL 工具审批桥：approvalMode='always' → approval_request；支持本会话允许
            onApprove: async ({ toolName, args }) => {
              const requestId = newRequestId()
              const emit = (event: import('@shared/types').StreamEvent): void =>
                emitStream({ type: 'orch_event', event })
              emit({ type: 'approval_request', request_id: requestId, node_id: node.id, tool_name: toolName, args })
              try {
                const response = await waitForUserInput(requestId, { nodeId: node.id, question: `approve ${toolName}` }, signal)
                emit({ type: 'approval_resolved', request_id: requestId, node_id: node.id, response })
                return resolveApprovalDecision(response, sid, toolName)
              } catch (e) {
                emit({ type: 'approval_resolved', request_id: requestId, node_id: node.id, response: '' })
                return { approved: false, reason: 'timeout or cancelled' }
              }
            },
          },
        }
        return opts
      },
    }

    // —— @提及意图分流（focusCap/directAgent 已在上方判定）——
    // focusCap：走主 Agent 路由（介绍能力 or 组队跑图），不在此直跳。
    // directAgent：纯 @角色直跳跑图。
    logger.info(
      `[home:route] mentions: agents=[${mentions.agents.map((a) => a.name).join(',')}] ` +
        `caps=[${mentions.capabilities.map((c) => c.name).join(',')}] skills=[${mentions.skills.map((s) => s.name).join(',')}] ` +
        `→ ${focusCap ? 'focusCap(主Agent介绍/组队)' : directAgent ? 'directAgent' : '主Agent路由'}`,
    )
    logger.info(
      `[trace:cap] home.chat.start session=${sid} focusCap=${focusCap?.id ?? '-'}(${focusCap?.name ?? '-'}) ` +
        `msgLen=${message.length} msgHead=${JSON.stringify(message.slice(0, 80))}`,
    )
    signal.addEventListener(
      'abort',
      () => logger.warn(`[trace:cap] home.signal.abort session=${sid}`),
      { once: true },
    )

    try {
      if (directAgent) {
        // 单/多角色：拼图跑（单角色单 agent 图；多角色 groupchat）
        emitStream({ type: 'run_id', sessionId: sid })
        const graph = buildTeamGraph(
          { role_ids: directAgent.map((a) => a.id) },
          getAgent,
          getCapability,
        )
        if (!graph) throw new IpcErrorThrow('errors:home.graph_build_failed', '组队图构建失败')
        const question = mentions.cleanText || message
        logger.info(`[trace:cap] home.directAgent → runTeam agents=${directAgent.map((a) => a.id).join(',')}`)
        const result = await runTeam(graph, question, sid, buildDeps, emitStream, signal)
        addMessage({ sessionId: sid, role: 'assistant', content: result.output })
        emitStream({ type: 'message_stop', stop_reason: 'end_turn' })
        logger.info(`[trace:cap] home.directAgent.end session=${sid} outputLen=${result.output.length}`)
        return { runId: sid }
      }

      // —— 意图路由（铁律24）：主 Agent 跑时 onText 不直接推前端，喂 detector ——
      // 安全文本推前端；判出组队起始后文本进 teamBuffer 不再推前端，改跑编排。
      const detector = new TeamJsonDetector()
      let finalText = ''
      let finalThinking = ''

      const streamCallbacks = {
        onText: (text: string) => {
          const safe = detector.feed(text)
          if (safe) emitStream({ type: 'text', text: safe })
        },
        onThinking: (text: string) => emitStream({ type: 'thinking', text }),
        onRetry: (info: {
          attempt: number
          maxRetries: number
          delayMs: number
          reason: string
        }) =>
          emitStream({
            type: 'retry',
            attempt: info.attempt,
            maxRetries: info.maxRetries,
            delayMs: info.delayMs,
            reason: info.reason,
          }),
        onToolResult: (tool: string, result: unknown) => {
          if (tool.startsWith('propose_')) emitProposeFailure(tool, String(result))
        },
      }

      const result = await agent.run(
        { messages: l1Messages, runId: sid, signal },
        streamCallbacks,
      )
      finalText = result.finalText
      finalThinking = result.finalThinking
      if (result.hitIterationLimit) {
        logger.warn('[home] 主 Agent 达工具轮次上限，已强制无工具收尾')
      }
      logger.info(
        `[trace:cap] home.mainAgent.end session=${sid} hitIterLimit=${result.hitIterationLimit} ` +
          `finalTextLen=${finalText.length} textTail=${JSON.stringify(finalText.slice(-80))}`,
      )

      // —— 创建幻觉补跑：自称已入库 / 否认持久化，但从未调 propose_* → 按 kind 定向挂工具再跑 ——
      // 挡「嘴上创建成功、确认卡从未出现」；澄清追问不触发（见 needsCreateRecovery）。
      if (
        proposeCount === 0 &&
        needsCreateRecovery(finalText) &&
        !signal.aborted &&
        proposeToolNames.length > 0
      ) {
        const inferred = inferCreateKind(message, finalText)
        const createTools = inferred
          ? agentTools.filter((t) => t.name === proposeToolNameForKind(inferred))
          : agentTools.filter((t) => t.name.startsWith('propose_'))
        const toolsForRecovery = createTools.length > 0 ? createTools : agentTools.filter((t) => t.name.startsWith('propose_'))
        const kindParam = inferred ?? 'unknown'
        logger.warn(
          `[home:create] recovery triggered: kind=${kindParam} reason=hallucination tools=${toolsForRecovery.map((t) => t.name).join(',')}`,
        )
        emitStream({
          type: 'create_notice',
          messageKey: 'home:create.recovery.pending',
          params: { kind: kindParam },
          level: 'warn',
        })
        const toolList = toolsForRecovery.map((t) => t.name).join(' / ')
        const recoveryAgent = new Agent(
          {
            ...config,
            tools: toolsForRecovery,
            instructions: `${config.instructions}\n\n【系统强制】你必须立即调用 ${toolList} 生成确认卡。本环境已具备入库链路。禁止声称没有存储或已入库。只调与对话匹配的一个 propose_*。`,
          },
          agent.deps,
        )
        const recovery = await recoveryAgent.run(
          {
            messages: [
              ...result.messages,
              {
                role: 'user',
                content: inferred
                  ? `（系统纠正）你刚才没有调用 propose_*，资产未入库。请立刻调用 ${proposeToolNameForKind(inferred)} 弹出确认卡。禁止再说「已入库」「没有持久化」「只是模拟」。`
                  : '（系统纠正）你刚才没有调用 propose_* 工具，资产并未写入库。请根据本对话里已确认的需求，立刻调用对应 propose_* 工具弹出确认卡。禁止再说「已入库」「没有持久化」「只是模拟」。',
              },
            ],
            runId: sid,
            signal,
          },
          streamCallbacks,
          { maxIterations: 4 },
        )
        if (recovery.finalThinking) finalThinking = recovery.finalThinking
        if (proposeCount > 0) {
          createRecovered = true
          // 补跑已弹出卡：历史不要留「已入库/没有持久化」谎言；正文由前端 notice/卡表达
          finalText = recovery.finalText?.trim() || ''
          logger.info(`[home:create] recovery done: proposed=${proposeCount}`)
        } else {
          logger.error(`[home:create] recovery done: proposed=0 kind=${kindParam}`)
          emitStream({
            type: 'create_notice',
            messageKey: 'home:create.recovery.failed',
            params: { kind: kindParam },
            level: 'error',
          })
          if (recovery.finalText) finalText = recovery.finalText
        }
      }

      // 创建事实源（A5）：proposed / hallucination_recovered / failed
      const lastProposed = proposedThisTurn[proposedThisTurn.length - 1]
      const createMeta: CreateMeta | undefined = lastProposed
        ? {
            status: createRecovered ? 'hallucination_recovered' : 'proposed',
            kind: lastProposed.kind,
            draftId: lastProposed.draftId,
          }
        : lastProposeFailKind && proposeCount === 0
          ? { status: 'failed', kind: lastProposeFailKind }
          : undefined

      // 流结束：判定直答 vs 组队
      const decision = detector.decide()
      logger.info(
        `[trace:cap] home.router.decide session=${sid} kind=${decision.kind}` +
          (decision.kind === 'team' ? ` json=${JSON.stringify(decision.json)}` : ''),
      )
      if (decision.kind === 'team') {
        // 组队：拼编排图跑 runner，事件经 orch_event 转前端
        logger.info('[home-router] 判为组队:', JSON.stringify(decision.json))
        emitStream({ type: 'run_id', sessionId: sid })
        const graph = buildTeamGraph(decision.json, getAgent, getCapability)
        if (graph) {
          logger.info(
            `[trace:cap] home.team.run session=${sid} graphNodes=${graph.nodes.length} ` +
              `types=[${graph.nodes.map((n) => `${n.id}:${n.type}`).join(',')}]`,
          )
          const teamResult = await runTeam(graph, message, sid, buildDeps, emitStream, signal)
          logger.info(
            `[trace:cap] home.team.done session=${sid} outputLen=${teamResult.output.length} ` +
              `tail=${JSON.stringify(teamResult.output.slice(-80))}`,
          )
          addMessage({
            sessionId: sid,
            role: 'assistant',
            content: teamResult.output,
            meta: {
              thinking: finalThinking || undefined,
              team: decision.json,
              ...(createMeta ? { create: createMeta } : {}),
            },
          })
        } else {
          // 组队 JSON 指向的 role/capability 全失效 → 回退直答
          logger.warn('[home-router] 组队图构建失败（role/capability 失效），回退直答')
          logger.warn(`[trace:cap] home.team.graph_build_failed session=${sid} json=${JSON.stringify(decision.json)}`)
          const direct = detector.flushDirect()
          if (direct) emitStream({ type: 'text', text: direct })
          addMessage({
            sessionId: sid,
            role: 'assistant',
            content: finalText,
            meta: {
              ...(finalThinking ? { thinking: finalThinking } : {}),
              ...(createMeta ? { create: createMeta } : {}),
            },
          })
        }
      } else {
        // 直答：flush 尾窗残留推前端，存档
        logger.info(
          `[trace:cap] home.direct session=${sid} focusCap=${!!focusCap} finalTextLen=${finalText.length}`,
        )
        const tail = detector.flushDirect()
        if (tail) emitStream({ type: 'text', text: tail })
        addMessage({
          sessionId: sid,
          role: 'assistant',
          content: finalText,
          meta: {
            ...(finalThinking ? { thinking: finalThinking } : {}),
            ...(createMeta ? { create: createMeta } : {}),
          },
        })
      }

      // 9. 会话结束异步触发 L2 精炼
      void refineL2(DEFAULT_USER_ID, sid, allMessages, compressFn).catch((e) =>
        logger.warn('[l2] 精炼失败', e),
      )

      // 10. 结束事件：触顶收尾用 max_iterations，便于前端/日志区分假 end_turn
      const stopReason = result.hitIterationLimit ? 'max_iterations' : 'end_turn'
      logger.info(`[trace:cap] home.message_stop session=${sid} reason=${stopReason} aborted=${signal.aborted}`)
      emitStream({
        type: 'message_stop',
        stop_reason: stopReason,
      })
    } catch (e) {
      // 错误推到 AI 气泡位置（而非聊天区上方），含可重试提示
      const msg = e instanceof Error ? e.message : String(e)
      logger.error(`[trace:cap] home.error session=${sid} aborted=${signal.aborted} err=${msg}`, e)
      emitStream({ type: 'error', error: msg })
      emitStream({ type: 'message_stop', stop_reason: 'error' })
      throw e
    } finally {
      // 聊天结束（含异常/取消）：驳回残留挂起提问 + 清控制器，防泄漏到下一场。
      // 只清自己的控制器：若期间新运行已接管（入口自动取消旧运行），不动新句柄
      rejectAllUserInputs('run_finished')
      // SkillContextProvider.afterRun（铁律22）：运行结束审计
      for (const p of skillProviders) p.afterRun()
      if (currentAbortController?.signal === signal) currentAbortController = null
    }

    return { runId: sid }
  })

  withHandler<void>('home:cancel', () => {
    rejectAllUserInputs('aborted') // 先驳回挂起提问，让工具侧收尾
    if (currentAbortController) {
      currentAbortController.abort()
      currentAbortController = null
      logger.info('[home:cancel] 已取消当前聊天/组队运行')
    }
  })

  // —— 聊天创建确认入库 ——
  // 前端确认卡点「确认」：payload 可能被用户改过，故以前端回传的 payload 为准落库；
  // draftId 用于从暂存取出核对 kind 并清理。确认后才真正 save*（铁律：确认入库才入库）。
  withHandler<{ id: string }>('home:confirmCreate', async (_e, input) => {
    const { draftId, kind, payload } = input as {
      draftId: string
      kind: CreateDraft['kind']
      payload: CreateDraft['payload']
    }
    pruneDrafts()
    const cached = pendingDrafts.get(draftId)?.draft
    if (cached && cached.kind !== kind) {
      throw new Error(`草稿类型不匹配（缓存 ${cached.kind} / 请求 ${kind}）`)
    }

    let saved: { id: string }
    if (kind === 'agent') {
      const p = payload as Extract<CreateDraft, { kind: 'agent' }>['payload']
      saved = saveAgent({
        name: p.name,
        description: p.description,
        instructions: p.instructions,
        outputConstraints: p.outputConstraints,
        temperature: p.temperature,
        maxTokens: p.maxTokens,
        source: 'custom',
      })
    } else if (kind === 'capability') {
      const p = payload as Extract<CreateDraft, { kind: 'capability' }>['payload']
      saved = saveCapability({ name: p.name, description: p.description, graph: p.graph })
    } else if (kind === 'skill') {
      const p = payload as Extract<CreateDraft, { kind: 'skill' }>['payload']
      saved = saveSkill({
        name: p.name,
        description: p.description,
        content: p.content,
        discipline: p.discipline,
      })
    } else if (kind === 'persona') {
      // 人设更新：instructions 传了则全量替换，未传保留原文（只改档案场景）；
      // profile 可选更新（未传字段保留原值）
      const p = payload as Extract<CreateDraft, { kind: 'persona' }>['payload']
      const existing = getPersona()
      const mergedProfile = {
        alias: p.profile?.alias ?? existing?.profile?.alias ?? '',
        role: p.profile?.role ?? existing?.profile?.role ?? '',
        preferredLanguage:
          p.profile?.preferredLanguage ?? existing?.profile?.preferredLanguage ?? 'zh-CN',
      }
      const updated = savePersona({
        id: 'home',
        // 兜底名（persona 首次创建才有；与设置页 profile.defaultName 对齐）
        name: existing?.name ?? '主助手',
        instructions: p.instructions ?? existing?.instructions ?? '',
        modelId: existing?.modelId,
        skillIds: existing?.skillIds ?? [],
        profile: mergedProfile,
      })
      saved = { id: updated.id }
    } else {
      throw new Error(`未知创建类型：${String(kind)}`)
    }

    pendingDrafts.delete(draftId)
    // R3：confirm 成功后写 meta.create.status=confirmed（供 B 期降级/事实源）
    const sessionId = cached?.sessionId
    if (sessionId) {
      const msg = findMessageByCreateDraftId(sessionId, draftId)
      if (msg) {
        const prevCreate = (msg.meta as { create?: CreateMeta } | undefined)?.create
        updateMessageMeta(msg.id, {
          create: {
            status: 'confirmed' as const,
            kind: prevCreate?.kind ?? kind,
            draftId,
          },
        })
      }
    }
    logger.info(`[home:create] confirmCreate: kind=${kind} id=${saved.id}`)
    return { id: saved.id }
  })

  // 前端确认卡点「取消」：丢弃草稿，不入库。
  withHandler<void>('home:cancelCreate', (_e, input) => {
    const { draftId } = input as { draftId: string }
    pendingDrafts.delete(draftId)
    logger.info('[home:create] 已取消草稿:', draftId)
  })

  // 列出未确认草稿（按会话）：回合结束 / 切回会话时重挂确认卡，防 streamMsgs 清空后卡片消失
  withHandler<CreateDraft[]>('home:listPendingDrafts', (_e, input) => {
    pruneDrafts()
    const sessionId = (input as { sessionId?: string } | undefined)?.sessionId
    const drafts: CreateDraft[] = []
    for (const { draft } of pendingDrafts.values()) {
      if (!sessionId || draft.sessionId === sessionId) drafts.push(draft)
    }
    return drafts
  })
}
