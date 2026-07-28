import { BrowserWindow } from 'electron'
import type { AgentConfig, LlmDelta, LlmMessage, Persona } from '@shared/types'
import { withHandler } from './handler'
import { getDefaultModel, resolveModelCredentials } from '../storage/models'
import { getPersona } from '../storage/models'
import { addMessage, createSession, listMessages } from '../storage/sessions'
import { Agent } from '../orchestrator/agent'
import { injectL0 } from '../storage/memory/l0'
import { buildL1Messages, maybeCompressL1 } from '../storage/memory/l1'
import { buildL2Injection, refineL2 } from '../storage/memory/l2'
import { getClient } from '../llm/retry'
import { listToolDefs } from '../tools/registry'
import { logger } from '../logger'

// —— 首页主助手聊天 IPC（§5.6 + §三之三 D/M + 铁律21）——
// 三级记忆注入：
//   L0 身份块 → instructions 开头（injectL0）
//   L1 会话摘要 → messages 首条 system msg（buildL1Messages）
//   L2 跨会话摘要 → instructions persona 段（buildL2Injection，限长 1500）
//   L3 → memory_recall/search 工具按需检索（不硬塞）
// L1 会话级摘要 vs agent 运行时 compaction：L1 在前先压缩存档，compaction
//   是 agent 运行时窗口截断防超 token（铁律21）。

const STREAM_CHANNEL = 'home:stream'
const DEFAULT_USER_ID = 'local'

function getMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

function emitStream(delta: LlmDelta): void {
  const win = getMainWindow()
  win?.webContents.send(STREAM_CHANNEL, delta)
}

/** LLM 压缩函数（供 L1/L2 调用） */
function makeCompressFn(modelId: string, apiKey?: string, baseURL?: string) {
  return async (text: string): Promise<string> => {
    const client = getClient(modelId, { apiKey, baseURL })
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

    // 2. persona + model + key
    const persona = getPersona()
    const model = getDefaultModel()
    if (!model) throw new Error('未配置模型，请先在设置页添加模型')

    const { apiKey, baseURL } = resolveModelCredentials(model)
    const compressFn = makeCompressFn(model.modelId, apiKey, baseURL)

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
    void _l1Summary // L1 已存 SQLite，buildL1Messages 内部读
    const l1Messages = buildL1Messages(sid, recentWindow)

    // 5. 拼装 instructions（§D 顺序）：L0 身份块 + L2 历史摘要 + persona instructions
    const baseInstructions = persona?.instructions ?? ''
    const l2 = buildL2Injection(DEFAULT_USER_ID)
    const instructionsWithL2 = l2
      ? `${baseInstructions}\n\n${l2}`
      : baseInstructions
    const instructions = injectL0(instructionsWithL2, persona)

    // 6. Agent（带 memory 工具：L3 recall/search/retain）
    const agent = new Agent(
      {
        name: 'home',
        instructions,
        modelId: model.modelId,
        tools: listToolDefs(),
        defaultOptions: { maxTokens: 16384 },
      },
      {
        llmOpts: { apiKey, baseURL },
        toolCtx: { sessionId: sid },
      },
    )

    // 7. Agent.run（messages 用 L1 注入后的）
    const result = await agent.run(
      { messages: l1Messages, runId: sid },
      { onText: (text) => emitStream({ type: 'text', text }) },
    )

    // 8. 存 assistant 回复
    addMessage({ sessionId: sid, role: 'assistant', content: result.finalText })

    // 9. 会话结束触发 L2 精炼（异步，不阻塞响应；这里 sid 已有完整对话则精炼）
    //    阈值：消息数超 6 条时精炼（避免短对话噪声）
    void refineL2(DEFAULT_USER_ID, sid, allMessages, compressFn).catch((e) =>
      logger.warn('[l2] 精炼失败', e),
    )

    // 10. 结束事件
    emitStream({ type: 'message_stop', stop_reason: 'end_turn' })

    return { runId: sid }
  })

  withHandler<void>('home:cancel', () => {
    logger.info('[home:cancel] 待 AbortController 接入（阶段6）')
  })
}
