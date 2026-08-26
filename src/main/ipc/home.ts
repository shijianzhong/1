import { BrowserWindow } from 'electron'
import type {
  AgentConfig,
  Attachment,
  CreateDraft,
  CreateMeta,
  HomeStreamEvent,
  LlmContentBlock,
  LlmMessage,
  TokenUsage,
} from '@shared/types'
import { IpcErrorThrow } from '@shared/types'
import { withHandler } from './handler'
import {
  getDefaultProvider,
  getPersona,
  getSkill,
  getAgent,
  getCapability,
  countSkills,
  listAgents,
  listCapabilities,
  listSkillMetas,
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
  getSession,
  listMessages,
  toLlmMessages,
  updateMessageMeta,
} from '../storage/sessions'
import { Agent } from '../orchestrator/agent'
import {
  TeamJsonDetector,
  buildCreateInstruction,
  buildKbInstruction,
  buildMemoryInstruction,
  buildSkillInstruction,
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
import { pluginHost } from '../plugins/host'
import { saveGeneratedPlugin, enableGeneratedPlugin } from '../plugins/generated'
import { saveGeneratedBPlugin, enableGeneratedBPlugin } from '../plugins/generatedB'
import { validateGeneratedSpec, validateGeneratedBSpec } from '../plugins/whitelist'
import { skillHostManager } from '../plugins/skillHost'
import { getDb } from '../storage/db'
import { injectL0 } from '../storage/memory/l0'
import { buildL1Messages, maybeCompressL1 } from '../storage/memory/l1'
import { buildL2Injection, refineL2 } from '../storage/memory/l2'
import { makeCompressFn } from '../llm/compress'
import { resolveThinkingConfig } from '../llm/thinking'
import { listToolsForAgents } from '../tools/mcp'
import { filterToolsByAllowlist } from '../tools/allowlist'
import { listMemoryKeysForPrompt } from '../tools/builtin/memory'
import { countKbChunks } from '../vector/kb-fts'
import { resolveApprovalDecision, rejectionToApprovalReason } from '../tools/sessionApprovals'
import {
  newRequestId,
  newRunId,
  rejectUserInputsForRun,
  waitForUserInput,
} from '../orchestrator/userInput'
import { listDrafts, removeDraft, writeDraft } from '../crash-recovery'
import { appendRunEvent, endRun, setRunRoute, startRun } from '../storage/runEvents'
import { randomUUID } from 'node:crypto'
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

/** 首页运行态：按 session 维度隔离，切会话不互相串扰。 */
const activeRuns = new Map<string, { controller: AbortController; hitlRunId: string }>()

/** 创建提案草稿暂存（draftId → {draft, ts}）；确认/取消删除，超时（30min）惰性清理；同步落盘防崩溃丢失。 */
const DRAFT_TTL_MS = 30 * 60 * 1000
/** 草稿驻留硬上限：正常流程单 figure 确认即删到不了上限；防异常 propose 风暴撑内存 */
const MAX_PENDING_DRAFTS = 100
const CREATE_DRAFT_PREFIX = 'create-'
const pendingDrafts = new Map<string, { draft: CreateDraft; ts: number }>()

function createDraftFileName(draftId: string): string {
  // draftId 已是 uuid 形态；剥路径字符防穿越
  const safe = draftId.replace(/[/\\]/g, '')
  return `${CREATE_DRAFT_PREFIX}${safe}.json`
}

function persistCreateDraft(draftId: string, entry: { draft: CreateDraft; ts: number }): void {
  writeDraft(createDraftFileName(draftId), JSON.stringify(entry))
}

function forgetCreateDraft(draftId: string): void {
  pendingDrafts.delete(draftId)
  removeDraft(createDraftFileName(draftId))
}

/** 启动时从 drafts/ 水合未确认创建卡（崩溃恢复后 listPendingDrafts 可重挂） */
function hydrateCreateDraftsFromDisk(): void {
  for (const f of listDrafts()) {
    if (!f.name.startsWith(CREATE_DRAFT_PREFIX) || !f.name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(f.content) as { draft?: CreateDraft; ts?: number }
      if (!parsed?.draft?.draftId || typeof parsed.ts !== 'number') continue
      if (Date.now() - parsed.ts > DRAFT_TTL_MS) {
        removeDraft(f.name)
        continue
      }
      pendingDrafts.set(parsed.draft.draftId, { draft: parsed.draft, ts: parsed.ts })
    } catch {
      removeDraft(f.name)
    }
  }
}

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
    if (now - entry.ts > DRAFT_TTL_MS) forgetCreateDraft(id)
  }
}

function getMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

function emitStream(delta: HomeStreamEvent): void {
  const win = getMainWindow()
  win?.webContents.send(STREAM_CHANNEL, delta)
}

export function registerHomeHandlers(): void {
  hydrateCreateDraftsFromDisk()
  withHandler<{ runId: string }>('home:chat', async (_e, input) => {
    const { message, sessionId, projectPath, mentions: explicitMentions, attachments } = input as {
      message: string
      sessionId?: string
      /** 项目根绝对路径（写入 sessions.cwd，文件工具/shell 用） */
      projectPath?: string
      /** 芯片旁路：展示正文是 @名字，此处带稳定 kind+id */
      mentions?: Array<{ kind: 'agent' | 'capability' | 'skill'; id: string }>
      /** 用户附件（图片/文件/文件夹） */
      attachments?: Attachment[]
    }

    // 1. session（新建时带 cwd；已存在且传 projectPath 则更新）
    const newSession = sessionId
      ? undefined
      : createSession({ title: message.slice(0, 20), cwd: projectPath })
    const sid = sessionId ?? newSession!.id
    const emit = (delta: HomeStreamEvent): void => {
      const scoped =
        delta.type === 'run_id'
          ? delta
          : ({ ...delta, sessionId: sid } as HomeStreamEvent)
      emitStream(scoped)
    }
    if (sessionId && projectPath) {
      getDb().prepare('UPDATE sessions SET cwd = ?, updated_at = ? WHERE id = ?').run(projectPath, Date.now(), sessionId)
    }

    // —— run_events 事实流：run 登记（session 确定即 run 开始）——
    // eventsRunId 与后续 hitlRunId 是两个概念：后者是 HITL 队列作用域，前者是诊断事实流归属。
    const eventsRunId = `run_${randomUUID()}`
    startRun({ id: eventsRunId, sessionId: sid, entry: 'home' })

    // 外层 try：兜住 startRun 之后、内层 try 之前这一段（provider 解析 / L0 注入 /
    // 技能装配 / 意图路由指令等，含 244/249 两个 IpcErrorThrow）的异常——否则这些 throw
    // 落到内层 catch 之外，run 行永久卡 'running'。外层 catch 不引用 signal/hitlRunId/
    // skillProviders（它们声明在 394/395/351，244 抛异常时尚未执行到 → ReferenceError），
    // 只用防御块收口 run 状态。
    // innerFailed 标记：内层 catch 已收口运行时失败时置 true，外层 catch 据此跳过重复
    // 收口——避免「内层 throw e 穿透到外层 catch」导致两条 home.run.failed 事件 +
    // 外层误标 phase='pre_inner_try'（CODE_REVIEW 双层 try 嵌套回归）。
    let innerFailed = false
    try {
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
    // 附件处理：图片→image content block；文件/文件夹→文本拼入正文
    let userText = message
    const imageBlocks: LlmContentBlock[] = []
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        if (att.type === 'image' && att.base64Data && att.mediaType) {
          imageBlocks.push({ type: 'image', mediaType: att.mediaType, data: att.base64Data })
        } else if (att.type === 'file' && att.textContent) {
          userText += `\n\n[文件: ${att.name}]\n${att.textContent}`
        } else if (att.type === 'folder' && att.treeSummary) {
          userText += `\n\n[文件夹: ${att.name}]\n${att.treeSummary}`
        }
      }
    }
    // LLM 用户消息：有图片时用结构化 content block，否则纯文本
    const userContent: string | LlmContentBlock[] = imageBlocks.length > 0
      ? [{ type: 'text', text: userText }, ...imageBlocks]
      : userText

    const history = listMessages(sid)
    // DB 存原始消息文本（图片不落库，太大）；附件元信息存 meta 供前端展示
    const attachmentMeta = attachments && attachments.length > 0
      ? attachments.map((a) => ({ type: a.type, name: a.name, size: a.size }))
      : undefined
    addMessage({
      sessionId: sid,
      role: 'user',
      content: userText,
      ...(attachmentMeta ? { meta: { attachments: attachmentMeta } } : {}),
    })

    // 历史重建：若消息含 meta.structured=true，content 是 JSON-stringified LlmContentBlock[]
    // （tool_use / tool_result 块），需还原为结构化 content 供 LLM 看到完整工具调用上下文
    const historyMessages = toLlmMessages(history)
    const allMessages: LlmMessage[] = [
      ...historyMessages,
      { role: 'user', content: userContent },
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
    const allSkills = listSkillMetas()
    const mentions = resolveMentions(
      message,
      allAgents,
      allCapabilities,
      allSkills,
      Array.isArray(explicitMentions) ? explicitMentions : [],
    )

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

    // —— @技能 仍走全文 inline；默认主 agent 技能能力改由 Skill RAG 指令激活 ——
    // mention 解析只需 id/name（轻量 SkillMeta）；content 在注入时通过 getSkill 懒加载
    const skillProviders: SkillContextProvider[] = []
    const mentionSkillIds = new Set(mentions.skills.map((s) => s.id))
    const homeSkillProvider = new SkillContextProvider(
      (sid) => (mentionSkillIds.has(sid) ? getSkill(sid) : null),
      pluginHost,
    )
    skillProviders.push(homeSkillProvider)
    const { instructions: instructionsWithSkills, injected: homeInjectedSkills } = homeSkillProvider.beforeRun({
      agentName: 'home',
      skillIds: skillHostManager.filterSkillIds([...mentionSkillIds]),
      instructions: instructionsWithL0,
    })
    if (homeInjectedSkills.length > 0) {
      // 诊断问题 2：命中了哪些 skill（含脚本/纪律标记）
      appendRunEvent(eventsRunId, 'skill.injected', {
        nodeId: 'home',
        skills: homeInjectedSkills,
      }, sid)
    }

    // —— 意图路由指令段（§三之三 M + 铁律24）：注入角色/能力清单 + 组队 JSON 约定 ——
    // 主 Agent 据此判断直答 vs 输出组队 JSON；无可用角色/能力时不注入（不打扰人设）。
    // @单能力（focusCap）：改注入能力聚焦块——主 Agent 介绍能力 or 输出组队 JSON 跑图（不直接跑图）。
    const routingInstruction = focusCap
      ? buildCapabilityFocusBlock(focusCap)
      : buildRoutingInstruction(allAgents, allCapabilities)
    const instructionsWithRouting = routingInstruction
      ? `${instructionsWithSkills}\n${routingInstruction}`
      : instructionsWithSkills

    const skillInstruction = buildSkillInstruction(countSkills())
    // —— 知识库激活指令段：门控注入——仅当用户确实索引了文档（chunkCount>0）才拼入，
    // 空库用户不注入、prompt 不膨胀、也不会白调 kb_search 空转一轮。
    // 与【长期记忆】并列但语义边界分离（文档素材 vs 个人事实），见 buildKbInstruction。
    const kbInstruction = buildKbInstruction(countKbChunks())
    // —— 创建指令段：引导主 Agent 识别创建/修改意图 → 多轮澄清 → propose_* 产出草稿。
    // 注入当前 persona 原文（<persona> 边界），防 LLM 把 L0/记忆/路由段误当人设固化。
    // —— 记忆策略指令段（铁律21 L3 激活）：告诉主 Agent 何时记/何时取，附已有记忆 key 防重复。
    const instructions = `${instructionsWithRouting}\n${skillInstruction}\n${buildCreateInstruction(persona)}\n${buildMemoryInstruction(listMemoryKeysForPrompt())}${kbInstruction}`

    // 取消控制器：按 session 维度隔离；同一会话重复发起时仅取消自己的旧运行。
    // 不同会话可并发，切换会话不应互相影响。
    const existingRun = activeRuns.get(sid)
    if (existingRun) {
      logger.warn(`[home] 会话 ${sid} 已有运行中的聊天，自动取消旧运行`)
      existingRun.controller.abort()
      rejectUserInputsForRun(existingRun.hitlRunId, 'aborted')
    }
    const abortController = new AbortController()
    const hitlRunId = newRunId('home')
    activeRuns.set(sid, { controller: abortController, hitlRunId })
    const { signal } = abortController

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
          emit({
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
        workspaceRoot: getSession(sid)?.cwd,
        signal,
        runId: eventsRunId,
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
            if (oldest) forgetCreateDraft(oldest)
          }
          const entry = { draft: stamped, ts: Date.now() }
          pendingDrafts.set(stamped.draftId, entry)
          persistCreateDraft(stamped.draftId, entry)
          emit({ type: 'proposal', draft: stamped })
          logger.info(`[home:create] propose invoked: kind=${stamped.kind} draftId=${stamped.draftId}`)
        },
        // HITL 提问桥（ask_user 工具）：事件经 orch_event 包装，前端渲染 AskUserCard；
        // respond 收口在 orchestrate:respond（与组队节点同一 userInput 队列）
        onAskUser: async ({ question, context }) => {
          const requestId = newRequestId()
          const emitOrchEvent = (event: import('@shared/types').StreamEvent): void =>
            emit({ type: 'orch_event', event })
          emitOrchEvent({ type: 'request_info', request_id: requestId, node_id: 'home', question, context })
          try {
            const answer = await waitForUserInput(requestId, { nodeId: 'home', question }, signal, hitlRunId)
            emitOrchEvent({ type: 'request_resolved', request_id: requestId, node_id: 'home', response: answer })
            return answer
          } catch (e) {
            emitOrchEvent({ type: 'request_resolved', request_id: requestId, node_id: 'home', response: '' })
            throw e
          }
        },
        // HITL 工具审批桥（shell_run / MCP always 工具）：approval_request 事件 + 挂起等用户确认
        // 应答 approved / approved_session / denied（本会话允许写入 sessionApprovals）
        onApprove: async ({ toolName, args }) => {
          const requestId = newRequestId()
          const emitOrchEvent = (event: import('@shared/types').StreamEvent): void =>
            emit({ type: 'orch_event', event })
          emitOrchEvent({ type: 'approval_request', request_id: requestId, node_id: 'home', tool_name: toolName, args })
          try {
            const response = await waitForUserInput(
              requestId,
              { nodeId: 'home', question: `approve ${toolName}` },
              signal,
              hitlRunId,
            )
            emitOrchEvent({ type: 'approval_resolved', request_id: requestId, node_id: 'home', response })
            return resolveApprovalDecision(response, sid, toolName)
          } catch (e) {
            // 超时/取消/被顶替：吞错返回 falsy 带区分 reason（铁律11 不抛 → 不死循环），
            // registry 闸门按 reason 选 errors.tools.approval_timeout/approval_aborted（CODE_AUDIT 断言 5.5）。
            emitOrchEvent({ type: 'approval_resolved', request_id: requestId, node_id: 'home', response: '' })
            return { approved: false, reason: rejectionToApprovalReason(e) }
          }
        },
        // update_plan 计划更新桥（Task 6）：推给前端展示计划进度
        onPlanUpdate: (p) => {
          emit({
            type: 'orch_event',
            event: {
              type: 'plan_update',
              node_id: 'home',
              explanation: p.explanation,
              plan: p.plan,
            },
          })
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
          allowedToolNames?: string[]
          modelId?: string
          temperature?: number
          maxTokens?: number
          outputConstraints?: string
          sourceAgentId?: string
          sourceCapabilityId?: string
        }
        const nodeThinking = resolveThinkingConfig(
          d.modelId ?? modelId,
          apiFormat,
          enableThinking,
        )
        // —— Skill 注入（铁律22，task 7.4）：组队图节点经 SkillContextProvider 注入 ——
        // （此前首页组队节点完全没注入 skill，与编辑器编排行为不齐）
        const nodeSkillProvider = new SkillContextProvider((sid) => getSkill(sid), pluginHost)
        skillProviders.push(nodeSkillProvider)
        const { instructions: nodeInstructions, injected: nodeInjectedSkills } = nodeSkillProvider.beforeRun({
          agentName: node.id,
          skillIds: skillHostManager.filterSkillIds(d.skillIds ?? []),
          instructions: d.instructions ?? '',
        })
        if (nodeInjectedSkills.length > 0) {
          appendRunEvent(eventsRunId, 'skill.injected', {
            nodeId: node.id,
            skills: nodeInjectedSkills,
          }, sid)
        }
        // outputConstraints 注入 instructions（与编辑器编排对齐，运行时才吃得到）
        const finalNodeInstructions = d.outputConstraints
          ? `${nodeInstructions}\n\n【输出约束】\n${d.outputConstraints}`
          : nodeInstructions
        // 资产级工具白名单：节点快照 → 源角色 → 源能力
        let allow = d.allowedToolNames
        if (!allow?.length && d.sourceAgentId) {
          allow = getAgent(d.sourceAgentId)?.allowedToolNames
        }
        if (!allow?.length && d.sourceCapabilityId) {
          allow = getCapability(d.sourceCapabilityId)?.allowedToolNames
        }
        const nodeTools = filterToolsByAllowlist(agentTools, allow)
        const cfg: AgentConfig = {
          // 铁律20：executor_id == 节点 id（runner 按节点 id 路由/查找），
          // 不能用 d.label（角色显示名）——否则 executors.get(node.id) 找不到 → 空白气泡
          name: node.id,
          description: d.description,
          instructions: finalNodeInstructions,
          modelId: d.modelId ?? modelId,
          tools: nodeTools,
          defaultOptions: { maxTokens: d.maxTokens ?? 16384, temperature: d.temperature },
          outputConstraints: d.outputConstraints,
          thinking: nodeThinking,
        }
        const opts: AgentExecutorOptions = {
          config: cfg,
          llmOpts: { apiKey, baseURL, authHeader, apiFormat },
          toolCtx: {
            sessionId: sid,
            workspaceRoot: getSession(sid)?.cwd,
            signal,
            runId: eventsRunId,
            // HITL 提问桥：事件经 orch_event 包装（与 runTeam 的流式事件同路），
            // respond 收口在 orchestrate:respond（同一 userInput 队列）
            onAskUser: async ({ question, context }) => {
              const requestId = newRequestId()
              const emitOrchEvent = (event: import('@shared/types').StreamEvent): void =>
                emit({ type: 'orch_event', event })
              emitOrchEvent({ type: 'request_info', request_id: requestId, node_id: node.id, question, context })
              try {
                const answer = await waitForUserInput(
                  requestId,
                  { nodeId: node.id, question },
                  signal,
                  hitlRunId,
                )
                emitOrchEvent({ type: 'request_resolved', request_id: requestId, node_id: node.id, response: answer })
                return answer
              } catch (e) {
                emitOrchEvent({ type: 'request_resolved', request_id: requestId, node_id: node.id, response: '' })
                throw e
              }
            },
            // HITL 工具审批桥：approvalMode='always' → approval_request；支持本会话允许
            onApprove: async ({ toolName, args }) => {
              const requestId = newRequestId()
              const emitOrchEvent = (event: import('@shared/types').StreamEvent): void =>
                emit({ type: 'orch_event', event })
              emitOrchEvent({ type: 'approval_request', request_id: requestId, node_id: node.id, tool_name: toolName, args })
              try {
                const response = await waitForUserInput(
                  requestId,
                  { nodeId: node.id, question: `approve ${toolName}` },
                  signal,
                  hitlRunId,
                )
                emitOrchEvent({ type: 'approval_resolved', request_id: requestId, node_id: node.id, response })
                return resolveApprovalDecision(response, sid, toolName)
              } catch (e) {
                // 超时/取消/被顶替：吞错返回 falsy 带区分 reason（铁律11 不抛 → 不死循环），
                // registry 闸门按 reason 选 errors.tools.approval_timeout/approval_aborted（CODE_AUDIT 断言 5.5）。
                emitOrchEvent({ type: 'approval_resolved', request_id: requestId, node_id: node.id, response: '' })
                return { approved: false, reason: rejectionToApprovalReason(e) }
              }
            },
            // update_plan 计划更新桥（Task 6 统一）：组队/能力节点与主 agent 同款
            onPlanUpdate: (p) => {
                emit({
                type: 'orch_event',
                event: {
                  type: 'plan_update',
                  node_id: node.id,
                  explanation: p.explanation,
                  plan: p.plan,
                },
              })
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
    // —— run_events 起步事实（诊断问题 1/2）：mentions 初判路由 ——
    appendRunEvent(eventsRunId, 'home.run.started', {
      sessionId: sid,
      msgLen: message.length,
      mentionAgents: mentions.agents.map((a) => a.id),
      mentionCaps: mentions.capabilities.map((c) => c.id),
      mentionSkills: mentions.skills.map((s) => s.id),
      preRoute: focusCap ? 'focusCap' : directAgent ? 'directAgent' : 'main',
    }, sid)
    emit({ type: 'run_id', sessionId: sid })

    try {
      if (directAgent) {
        // 单/多角色：拼图跑（单角色单 agent 图；多角色 groupchat）
        setRunRoute(eventsRunId, 'directAgent')
        appendRunEvent(eventsRunId, 'home.route.decided', {
          decision: 'directAgent',
          agents: directAgent.map((a) => a.id),
        }, sid)
        const graph = buildTeamGraph(
          { role_ids: directAgent.map((a) => a.id) },
          getAgent,
          getCapability,
        )
        if (!graph) throw new IpcErrorThrow('errors:home.graph_build_failed', '组队图构建失败')
        const question = mentions.cleanText || message
        logger.info(`[trace:cap] home.directAgent → runTeam agents=${directAgent.map((a) => a.id).join(',')}`)
        const teamTurnStart = Date.now()
        const result = await runTeam(graph, question, sid, buildDeps, emit, signal, eventsRunId)
        const teamTurnEnd = Date.now()
        addMessage({
          sessionId: sid,
          role: 'assistant',
          content: result.output,
          meta: {
            timing: { startedAt: teamTurnStart, completedAt: teamTurnEnd },
          },
        })
        emit({ type: 'message_stop', stop_reason: 'end_turn' })
        endRun(eventsRunId, 'completed')
        appendRunEvent(eventsRunId, 'home.run.completed', {
          stopReason: 'end_turn', outputLen: result.output.length, ms: teamTurnEnd - teamTurnStart,
        }, sid)
        logger.info(`[trace:cap] home.directAgent.end session=${sid} outputLen=${result.output.length}`)
        return { runId: sid }
      }

      // —— 意图路由（铁律24）：主 Agent 跑时 onText 不直接推前端，喂 detector ——
      // 安全文本推前端；判出组队起始后文本进 teamBuffer 不再推前端，改跑编排。
      const detector = new TeamJsonDetector()
      let finalText = ''
      let finalThinking = ''
      const turnStart = Date.now()
      let turnUsage: TokenUsage | undefined
      // 工具调用记录：onToolCall/onToolResult 积累，回合结束存入 meta.toolCalls
      const toolCallLog: Array<{
        id: string
        tool: string
        argsSummary: string
        resultSummary?: string
        status: 'pending' | 'done' | 'error'
        timestamp: number
      }> = []

      const streamCallbacks = {
        onText: (text: string) => {
          const safe = detector.feed(text)
          if (safe) emit({ type: 'text', text: safe })
        },
        onThinking: (text: string) => emit({ type: 'thinking', text }),
        onRetry: (info: {
          attempt: number
          maxRetries: number
          delayMs: number
          reason: string
        }) =>
          emit({
            type: 'retry',
            attempt: info.attempt,
            maxRetries: info.maxRetries,
            delayMs: info.delayMs,
            reason: info.reason,
          }),
        onToolCall: (tool: string, args: unknown, toolUseId: string) => {
          logger.info(`[trace:cap] home.tool_call tool=${tool} args=${JSON.stringify(args).slice(0, 200)}`)
          toolCallLog.push({
            id: toolUseId,
            tool,
            argsSummary: JSON.stringify(args).slice(0, 200),
            status: 'pending',
            timestamp: Date.now(),
          })
          emit({
            type: 'orch_event',
            event: { type: 'tool_call', node_id: 'home', tool, args },
          })
        },
        onToolResult: (tool: string, result: unknown, toolUseId: string) => {
          const resultStr = typeof result === 'string' ? result : JSON.stringify(result)
          logger.info(`[trace:cap] home.tool_result tool=${tool} resultLen=${resultStr.length} result=${resultStr.slice(0, 200)}`)
          // 更新对应的 toolCallLog 条目
          const entry = toolCallLog.find((tc) => tc.id === toolUseId && tc.status === 'pending')
          if (entry) {
            const isError = typeof result === 'object' && result !== null && 'ok' in result && (result as { ok: boolean }).ok === false
            entry.status = isError ? 'error' : 'done'
            entry.resultSummary = resultStr.slice(0, 200)
          }
          emit({
            type: 'orch_event',
            event: { type: 'tool_result', node_id: 'home', result },
          })
          if (tool.startsWith('propose_')) emitProposeFailure(tool, String(result))
        },
        onMessageStop: (usage?: TokenUsage) => {
          if (usage) {
            turnUsage = {
              inputTokens: (turnUsage?.inputTokens ?? 0) + (usage.inputTokens ?? 0),
              outputTokens: (turnUsage?.outputTokens ?? 0) + (usage.outputTokens ?? 0),
              totalTokens: (turnUsage?.totalTokens ?? 0) + (usage.totalTokens ?? 0),
            }
          }
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

      // —— 保存中间消息到 DB（供下一轮历史重建）——
      // Agent.run 的 messages 数组包含完整工具调用上下文（tool_use 块 + tool_result 块），
      // 但之前只存了最终文本，导致 LLM 下轮看不到上轮的工具调用模式，无法借鉴。
      // 这里把 input 之后的所有中间消息（除最终 assistant 回复外）以 structured JSON 存入 DB。
      const turnMessages = result.messages.slice(l1Messages.length)
      // 最后一条是最终 assistant 回复（单独存 finalText），跳过
      for (const msg of turnMessages.slice(0, -1)) {
        const isStructured = typeof msg.content !== 'string'
        addMessage({
          sessionId: sid,
          role: msg.role === 'user' ? 'tool' : 'assistant',
          content: isStructured ? JSON.stringify(msg.content) : (msg.content as string),
          meta: isStructured ? { structured: true, intermediate: true } : { intermediate: true },
        })
      }

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
        emit({
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
        // 保存 recovery 路径的中间消息（跳过输入消息 + 系统纠正消息，跳过最终回复）
        const recoveryNewMessages = recovery.messages.slice(result.messages.length + 1)
        for (const msg of recoveryNewMessages.slice(0, -1)) {
          const isStructured = typeof msg.content !== 'string'
          addMessage({
            sessionId: sid,
            role: msg.role === 'user' ? 'tool' : 'assistant',
            content: isStructured ? JSON.stringify(msg.content) : (msg.content as string),
            meta: isStructured ? { structured: true, intermediate: true } : { intermediate: true },
          })
        }
        if (proposeCount > 0) {
          createRecovered = true
          // 补跑已弹出卡：历史不要留「已入库/没有持久化」谎言；正文由前端 notice/卡表达
          finalText = recovery.finalText?.trim() || ''
          logger.info(`[home:create] recovery done: proposed=${proposeCount}`)
        } else {
          logger.error(`[home:create] recovery done: proposed=0 kind=${kindParam}`)
          emit({
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
      const turnEnd = Date.now()
      const timingMeta = { startedAt: turnStart, completedAt: turnEnd }
      logger.info(
        `[trace:cap] home.router.decide session=${sid} kind=${decision.kind}` +
          (decision.kind === 'team' ? ` json=${JSON.stringify(decision.json)}` : ''),
      )
      // 终判路由回填 + 事实事件（诊断问题 1：本次到底直答还是转 team 了）
      setRunRoute(eventsRunId, decision.kind === 'team' ? 'team' : 'direct')
      appendRunEvent(eventsRunId, 'home.route.decided', {
        decision: decision.kind,
        focusCapId: focusCap?.id,
        ...(decision.kind === 'team' ? { team: decision.json } : {}),
      }, sid)
      if (decision.kind === 'team') {
        // 组队：拼编排图跑 runner，事件经 orch_event 转前端
        logger.info('[home-router] 判为组队:', JSON.stringify(decision.json))
        const graph = buildTeamGraph(decision.json, getAgent, getCapability)
        if (graph) {
          logger.info(
            `[trace:cap] home.team.run session=${sid} graphNodes=${graph.nodes.length} ` +
              `types=[${graph.nodes.map((n) => `${n.id}:${n.type}`).join(',')}]`,
          )
          const teamResult = await runTeam(graph, message, sid, buildDeps, emit, signal, eventsRunId)
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
              timing: timingMeta,
              ...(turnUsage ? { tokenUsage: turnUsage } : {}),
              ...(createMeta ? { create: createMeta } : {}),
              ...(toolCallLog.length > 0 ? { toolCalls: toolCallLog } : {}),
            },
          })
        } else {
          // 组队 JSON 指向的 role/capability 全失效 → 回退直答
          logger.warn('[home-router] 组队图构建失败（role/capability 失效），回退直答')
          logger.warn(`[trace:cap] home.team.graph_build_failed session=${sid} json=${JSON.stringify(decision.json)}`)
          const direct = detector.flushDirect()
          if (direct) emit({ type: 'text', text: direct })
          addMessage({
            sessionId: sid,
            role: 'assistant',
            content: finalText,
            meta: {
              ...(finalThinking ? { thinking: finalThinking } : {}),
              timing: timingMeta,
              ...(turnUsage ? { tokenUsage: turnUsage } : {}),
              ...(createMeta ? { create: createMeta } : {}),
              ...(toolCallLog.length > 0 ? { toolCalls: toolCallLog } : {}),
            },
          })
        }
      } else {
        // 直答：flush 尾窗残留推前端，存档
        logger.info(
          `[trace:cap] home.direct session=${sid} focusCap=${!!focusCap} finalTextLen=${finalText.length}`,
        )
        const tail = detector.flushDirect()
        if (tail) emit({ type: 'text', text: tail })
        addMessage({
          sessionId: sid,
          role: 'assistant',
          content: finalText,
          meta: {
            ...(finalThinking ? { thinking: finalThinking } : {}),
            timing: timingMeta,
            ...(turnUsage ? { tokenUsage: turnUsage } : {}),
            ...(createMeta ? { create: createMeta } : {}),
            ...(toolCallLog.length > 0 ? { toolCalls: toolCallLog } : {}),
          },
        })
      }

      // 9. 会话结束异步触发 L2 精炼
      void refineL2(DEFAULT_USER_ID, sid, allMessages, compressFn).catch((e) =>
        logger.warn('[l2] 精炼失败', e),
      )

      // 10. 结束事件：触顶收尾用 max_iterations，便于前端/日志区分假 end_turn
      const stopReason = result.hitIterationLimit ? 'max_iterations' : 'end_turn'
      logger.info(`[trace:cap] home.message_stop session=${sid} reason=${stopReason} aborted=${signal.aborted} usage=${turnUsage ? JSON.stringify(turnUsage) : 'none'}`)
      endRun(eventsRunId, 'completed')
      appendRunEvent(eventsRunId, 'home.run.completed', {
        stopReason,
        route: decision.kind,
        ms: turnEnd - turnStart,
        ...(turnUsage ? { usage: turnUsage } : {}),
      }, sid)
      emit({
        type: 'message_stop',
        stop_reason: stopReason,
        ...(turnUsage ? { usage: turnUsage } : {}),
      })
    } catch (e) {
      // 错误推到 AI 气泡位置（而非聊天区上方），含可重试提示
      const msg = e instanceof Error ? e.message : String(e)
      logger.error(`[trace:cap] home.error session=${sid} aborted=${signal.aborted} err=${msg}`, e)
      endRun(eventsRunId, signal.aborted ? 'aborted' : 'error')
      appendRunEvent(eventsRunId, 'home.run.failed', { error: msg, aborted: signal.aborted }, sid)
      emit({ type: 'error', error: msg })
      emit({ type: 'message_stop', stop_reason: 'error' })
      innerFailed = true // 标记：外层 catch 据此跳过重复收口（内层已处理运行时失败）
      throw e
    } finally {
      // 仅驳回本 run 的挂起提问，避免误伤编辑器 orchestrate 通道
      rejectUserInputsForRun(hitlRunId, 'run_finished')
      // SkillContextProvider.afterRun（铁律22）：运行结束审计
      for (const p of skillProviders) p.afterRun()
      const active = activeRuns.get(sid)
      if (active?.controller.signal === signal && active.hitlRunId === hitlRunId) {
        activeRuns.delete(sid)
      }
    }
    } catch (e) {
      // 外层兜底（CODE_REVIEW P0）：startRun 后、内层 try 前抛异常时 run 行收口。
      // 不引用 signal/hitlRunId/skillProviders（此阶段可能未声明）；
      // endRun 带 WHERE status='running'，幂等，内层已收口的失败重复调用无害。
      // 内层 catch 的 throw e 会穿透到此处，但 innerFailed=true 时已收口，跳过重复
      // 事件——否则同一失败会写出两条 home.run.failed 且外层误标 phase='pre_inner_try'。
      if (!innerFailed) {
        const errMsg = e instanceof Error ? e.message : String(e)
        try { endRun(eventsRunId, 'error') } catch { /* 观测层不阻断业务异常向上抛 */ }
        try { appendRunEvent(eventsRunId, 'home.run.failed', { error: errMsg, phase: 'pre_inner_try' }, sid) } catch {}
      }
      throw e
    }

    return { runId: sid }
  })

  withHandler<void>('home:cancel', (_e, input) => {
    const sid = (input as { sessionId?: string } | undefined)?.sessionId
    if (!sid) return
    const run = activeRuns.get(sid)
    if (!run) return
    rejectUserInputsForRun(run.hitlRunId, 'aborted')
    run.controller.abort()
    activeRuns.delete(sid)
    logger.info(`[home:cancel] 已取消会话 ${sid} 的聊天/组队运行`)
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
    } else if (kind === 'generated') {
      // generated/A 声明式工具：保存 manifest + 立即 onLoad 注册进 registry
      // （docs/PLUGIN_ARCHITECTURE.md §5 Stage 2——造完立刻可用）
      const p = payload as Extract<CreateDraft, { kind: 'generated' }>['payload']
      // 闸门前置：非法 spec 直接报错、不落盘，避免留下 enabled 死工具（onLoad 内校验仅兜底）
      const v = validateGeneratedSpec(p)
      if (!v.ok) {
        throw new Error(`generated 工具校验失败（${v.reason}）：未创建`)
      }
      const file = saveGeneratedPlugin({ spec: p })
      // 立即注册（enabled=true，注册点白名单校验在 onLoad 内再兜底一次）
      await enableGeneratedPlugin(pluginHost, file.id)
      saved = { id: file.id }
    } else if (kind === 'generated_b') {
      // generated/B 代码型工具：保存 manifest + handler.js + 立即 onLoad 注册占位（trustedBy=null）
      // （docs/PLUGIN_ARCHITECTURE.md §5 Stage 3——造完立刻入库为"未信任"占位，用户须去 /plugins 信任）
      const p = payload as Extract<CreateDraft, { kind: 'generated_b' }>['payload']
      // 闸门前置：handlerSource 非空 + 可编译 + inputSchema 结构；失败抛 IpcErrorThrow 让前端拿 i18n key
      const v = validateGeneratedBSpec(p)
      if (!v.ok) {
        throw new IpcErrorThrow(
          v.reason === 'compile_failed' ? 'errors:plugins.compile_failed' : v.messageKey,
          `generated_b 工具校验失败（${v.reason}）：未创建`,
        )
      }
      const file = saveGeneratedBPlugin({ spec: p })
      // 立即注册（enabled=true，trustedBy=null → 占位工具返 trusted_required，注册点校验在 onLoad 内再兜底）
      await enableGeneratedBPlugin(pluginHost, file.id)
      saved = { id: file.id }
    } else {
      throw new Error(`未知创建类型：${String(kind)}`)
    }

    forgetCreateDraft(draftId)
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
    forgetCreateDraft(draftId)
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
