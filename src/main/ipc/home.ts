import { BrowserWindow } from 'electron'
import type { AgentConfig, HomeStreamEvent, LlmMessage, Persona } from '@shared/types'
import { withHandler } from './handler'
import {
  getDefaultProvider,
  getPersona,
  getSkill,
  getAgent,
  getCapability,
  listAgents,
  listCapabilities,
  resolveProviderCredentials,
} from '../storage/models'
import { addMessage, createSession, listMessages } from '../storage/sessions'
import { Agent } from '../orchestrator/agent'
import {
  TeamJsonDetector,
  buildRoutingInstruction,
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

    // —— Skill 注入（§铁律22）：persona 也可绑定 skill，inline 成 <skill> XML 块拼入 instructions ——
    const personaSkillIds = persona?.skillIds ?? []
    const skillBlocks: string[] = []
    for (const sid of personaSkillIds) {
      const skill = getSkill(sid)
      if (!skill) {
        logger.warn(`[home] persona 绑定的 skill ${sid} 不存在，跳过`)
        continue
      }
      const content = skill.content.length > 24000
        ? skill.content.slice(0, 24000) + '\n\n[... skill 内容超长截断 ...]'
        : skill.content
      const desc = skill.description ? `\n  description: ${skill.description}` : ''
      skillBlocks.push(`<skill name="${skill.name}"${desc}>\n${content}\n</skill>`)
    }
    const instructionsWithSkills = skillBlocks.length > 0
      ? `${instructionsWithL0}\n\n${skillBlocks.join('\n\n')}`
      : instructionsWithL0

    // —— 意图路由指令段（§三之三 M + 铁律24）：注入角色/能力清单 + 组队 JSON 约定 ——
    // 主 Agent 据此判断直答 vs 输出组队 JSON；无可用角色/能力时不注入（不打扰人设）。
    const routingInstruction = buildRoutingInstruction(listAgents(), listCapabilities())
    const instructions = routingInstruction
      ? `${instructionsWithSkills}\n${routingInstruction}`
      : instructionsWithSkills

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
      toolCtx: { sessionId: sid },
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
    const mentions = resolveMentions(message, listAgents(), listCapabilities())
    const directCap = mentions.capabilities.length === 1 && mentions.agents.length === 0
      ? mentions.capabilities[0]
      : null
    const directAgent = mentions.agents.length >= 1 && mentions.capabilities.length === 0
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
}
