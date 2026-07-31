import { BrowserWindow } from 'electron'
import type { AgentConfig, CreateDraft, HomeStreamEvent, LlmMessage, Persona } from '@shared/types'
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
import { addMessage, createSession, listMessages } from '../storage/sessions'
import { Agent } from '../orchestrator/agent'
import {
  TeamJsonDetector,
  buildCreateInstruction,
  buildMemoryInstruction,
  buildRoutingInstruction,
  buildSkillBlocks,
  buildTeamGraph,
  resolveMentions,
  runTeam,
} from '../orchestrator/home'
import { injectL0 } from '../storage/memory/l0'
import { buildL1Messages, maybeCompressL1 } from '../storage/memory/l1'
import { buildL2Injection, refineL2 } from '../storage/memory/l2'
import { getClient } from '../llm/retry'
import { resolveThinkingConfig } from '../llm/thinking'
import { listToolDefs } from '../tools/registry'
import { listMemoryKeysForPrompt } from '../tools/builtin/memory'
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

/** 创建提案草稿暂存（draftId → {draft, ts}）；确认/取消删除，超时（30min）惰性清理。 */
const DRAFT_TTL_MS = 30 * 60 * 1000
const pendingDrafts = new Map<string, { draft: CreateDraft; ts: number }>()

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
) {
  return async (text: string): Promise<string> => {
    const client = getClient(modelId, { apiKey, baseURL, authHeader })
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
    if (!provider) throw new Error('未配置供应商，请先在模型页添加供应商')
    const { apiKey, baseURL, authHeader, modelId, enableThinking, apiFormat } = resolveProviderCredentials(provider, 'default')
    logger.info('[home] provider:', provider.name, 'enableThinking:', enableThinking, 'modelId:', modelId)
    if (!modelId) throw new Error('供应商未配置默认模型')
    const compressFn = makeCompressFn(modelId, apiKey, baseURL, authHeader)

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

    // —— Skill 注入（§铁律22）：persona 绑定 skill + @skill 动态注入，inline 成 <skill> XML 块 ——
    const personaSkillIds = persona?.skillIds ?? []
    const personaSkills = personaSkillIds
      .map((sid) => {
        const s = getSkill(sid)
        if (!s) logger.warn(`[home] persona 绑定的 skill ${sid} 不存在，跳过`)
        return s
      })
      .filter((s): s is NonNullable<typeof s> => !!s)
    // @skill 与 persona 绑定 skill 去重（同 id 不重复注入）
    const boundIds = new Set(personaSkills.map((s) => s.id))
    const mentionSkills = mentions.skills.filter((s) => !boundIds.has(s.id))
    const skillBlocks = buildSkillBlocks([...personaSkills, ...mentionSkills])
    const instructionsWithSkills = skillBlocks.length > 0
      ? `${instructionsWithL0}\n\n${skillBlocks.join('\n\n')}`
      : instructionsWithL0

    // —— 意图路由指令段（§三之三 M + 铁律24）：注入角色/能力清单 + 组队 JSON 约定 ——
    // 主 Agent 据此判断直答 vs 输出组队 JSON；无可用角色/能力时不注入（不打扰人设）。
    const routingInstruction = buildRoutingInstruction(allAgents, allCapabilities)
    const instructionsWithRouting = routingInstruction
      ? `${instructionsWithSkills}\n${routingInstruction}`
      : instructionsWithSkills

    // —— 创建指令段：引导主 Agent 识别创建/修改意图 → 多轮澄清 → propose_* 产出草稿。
    // 注入当前 persona 原文（<persona> 边界），防 LLM 把 L0/记忆/路由段误当人设固化。
    // —— 记忆策略指令段（铁律21 L3 激活）：告诉主 Agent 何时记/何时取，附已有记忆 key 防重复。
    const instructions = `${instructionsWithRouting}\n${buildCreateInstruction(persona)}\n${buildMemoryInstruction(listMemoryKeysForPrompt())}`

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
      tools: listToolDefs(),
      defaultOptions: { maxTokens: 16384 },
      thinking,
    }
    const agent = new Agent(config, {
      llmOpts: { apiKey, baseURL, authHeader },
      toolCtx: {
        sessionId: sid,
        // propose_* 工具产出草稿 → 经此桥 emitStream proposal → 前端确认卡（不落库）
        onPropose: (draft) => {
          pruneDrafts()
          pendingDrafts.set(draft.draftId, { draft, ts: Date.now() })
          emitStream({ type: 'proposal', draft })
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
        const cfg: AgentConfig = {
          name: d.label ?? node.id,
          description: d.description,
          instructions: d.instructions ?? '',
          modelId: d.modelId ?? modelId,
          tools: listToolDefs(),
          defaultOptions: { maxTokens: d.maxTokens ?? 16384, temperature: d.temperature },
          outputConstraints: d.outputConstraints,
          thinking: nodeThinking,
        }
        const opts: AgentExecutorOptions = {
          config: cfg,
          llmOpts: { apiKey, baseURL, authHeader },
          toolCtx: { sessionId: sid },
        }
        return opts
      },
    }

    // —— @提及直跳（用户明确意图，比 LLM 路由更准，不过 LLM 判定）——
    // mentions 已在上方 skill 注入前解析（含 agents/capabilities/skills）。
    // 仅纯角色/纯能力触发直跳；含 @skill 时仍需走主 Agent（skill 已注入其上下文）。
    const directCap = mentions.capabilities.length === 1 &&
      mentions.agents.length === 0 &&
      mentions.skills.length === 0
      ? mentions.capabilities[0]
      : null
    const directAgent = mentions.agents.length >= 1 &&
      mentions.capabilities.length === 0 &&
      mentions.skills.length === 0
      ? mentions.agents
      : null

    try {
      if (directCap) {
        // 单能力：直接跑能力图
        emitStream({ type: 'run_id', sessionId: sid })
        const cap = getCapability(directCap.id)
        if (!cap) throw new Error(`能力 ${directCap.name} 不存在`)
        const question = mentions.cleanText || message
        const result = await runTeam(cap.graph, question, sid, buildDeps, emitStream)
        addMessage({ sessionId: sid, role: 'assistant', content: result.output })
        emitStream({ type: 'message_stop', stop_reason: 'end_turn' })
        return { runId: sid }
      }

      if (directAgent) {
        // 单/多角色：拼图跑（单角色单 agent 图；多角色 groupchat）
        emitStream({ type: 'run_id', sessionId: sid })
        const graph = buildTeamGraph(
          { role_ids: directAgent.map((a) => a.id) },
          getAgent,
          getCapability,
        )
        if (!graph) throw new Error('组队图构建失败')
        const question = mentions.cleanText || message
        const result = await runTeam(graph, question, sid, buildDeps, emitStream)
        addMessage({ sessionId: sid, role: 'assistant', content: result.output })
        emitStream({ type: 'message_stop', stop_reason: 'end_turn' })
        return { runId: sid }
      }

      // —— 意图路由（铁律24）：主 Agent 跑时 onText 不直接推前端，喂 detector ——
      // 安全文本推前端；判出组队起始后文本进 teamBuffer 不再推前端，改跑编排。
      const detector = new TeamJsonDetector()
      let finalText = ''
      let finalThinking = ''

      const result = await agent.run(
        { messages: l1Messages, runId: sid },
        {
          onText: (text) => {
            const safe = detector.feed(text)
            if (safe) emitStream({ type: 'text', text: safe })
          },
          onThinking: (text) => emitStream({ type: 'thinking', text }),
          onRetry: (info) =>
            emitStream({
              type: 'retry',
              attempt: info.attempt,
              maxRetries: info.maxRetries,
              delayMs: info.delayMs,
              reason: info.reason,
            }),
        },
      )
      finalText = result.finalText
      finalThinking = result.finalThinking

      // 流结束：判定直答 vs 组队
      const decision = detector.decide()
      if (decision.kind === 'team') {
        // 组队：拼编排图跑 runner，事件经 orch_event 转前端
        logger.info('[home-router] 判为组队:', JSON.stringify(decision.json))
        emitStream({ type: 'run_id', sessionId: sid })
        const graph = buildTeamGraph(decision.json, getAgent, getCapability)
        if (graph) {
          const teamResult = await runTeam(graph, message, sid, buildDeps, emitStream)
          addMessage({
            sessionId: sid,
            role: 'assistant',
            content: teamResult.output,
            meta: { thinking: finalThinking || undefined, team: decision.json },
          })
        } else {
          // 组队 JSON 指向的 role/capability 全失效 → 回退直答
          logger.warn('[home-router] 组队图构建失败（role/capability 失效），回退直答')
          const direct = detector.flushDirect()
          if (direct) emitStream({ type: 'text', text: direct })
          addMessage({
            sessionId: sid,
            role: 'assistant',
            content: finalText,
            meta: finalThinking ? { thinking: finalThinking } : undefined,
          })
        }
      } else {
        // 直答：flush 尾窗残留推前端，存档
        const tail = detector.flushDirect()
        if (tail) emitStream({ type: 'text', text: tail })
        addMessage({
          sessionId: sid,
          role: 'assistant',
          content: finalText,
          meta: finalThinking ? { thinking: finalThinking } : undefined,
        })
      }

      // 9. 会话结束异步触发 L2 精炼
      void refineL2(DEFAULT_USER_ID, sid, allMessages, compressFn).catch((e) =>
        logger.warn('[l2] 精炼失败', e),
      )

      // 10. 结束事件
      emitStream({ type: 'message_stop', stop_reason: 'end_turn' })
    } catch (e) {
      // 错误推到 AI 气泡位置（而非聊天区上方），含可重试提示
      const msg = e instanceof Error ? e.message : String(e)
      emitStream({ type: 'error', error: msg })
      emitStream({ type: 'message_stop', stop_reason: 'error' })
      throw e
    }

    return { runId: sid }
  })

  withHandler<void>('home:cancel', () => {
    logger.info('[home:cancel] 待 AbortController 接入（阶段6）')
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
    logger.info(`[home:create] 已入库 ${kind}:`, saved.id)
    return { id: saved.id }
  })

  // 前端确认卡点「取消」：丢弃草稿，不入库。
  withHandler<void>('home:cancelCreate', (_e, input) => {
    const { draftId } = input as { draftId: string }
    pendingDrafts.delete(draftId)
    logger.info('[home:create] 已取消草稿:', draftId)
  })
}
