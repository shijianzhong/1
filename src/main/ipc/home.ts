import { BrowserWindow } from 'electron'
import type { LlmDelta, Persona } from '@shared/types'
import { withHandler } from './handler'
import { getDb } from '../storage/db'
import { getDefaultModel, getModel } from '../storage/models'
import { getPersona } from '../storage/models'
import { addMessage, createSession, listMessages } from '../storage/sessions'
import { getKey } from '../secrets/vault'
import { Agent } from '../orchestrator/agent'
import type { AgentConfig } from '@shared/types'
import { logger } from '../logger'

// —— 首页主助手聊天 IPC（§5.6 + §三之三 M）——
// home:chat 发起一轮对话：加载 persona + 历史 → Agent.run → 流式推渲染层。
// 流式经 mainWindow.webContents.send('home:stream', delta)，渲染层 onStream 订阅。

const STREAM_CHANNEL = 'home:stream'

function getMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

function emitStream(delta: LlmDelta): void {
  const win = getMainWindow()
  win?.webContents.send(STREAM_CHANNEL, delta)
}

function buildAgentConfig(persona: Persona | null, modelId: string, apiKey?: string): AgentConfig {
  return {
    name: 'home',
    instructions: persona?.instructions ?? '',
    modelId,
    // apiKey 经 vault 解密后传入 client（铁律3：明文不出主进程）
    // Agent 内部 getClient 会用 llmOpts.apiKey
    defaultOptions: { maxTokens: 16384 },
    // 阶段2 先无工具（记忆工具阶段3接）
  }
}

export function registerHomeHandlers(): void {
  withHandler<{ runId: string }>('home:chat', async (_e, input) => {
    const { message, sessionId } = input as { message: string; sessionId?: string }

    // 1. session
    const session =
      sessionId ? undefined : createSession({ title: message.slice(0, 20) })
    const sid = sessionId ?? session!.id

    // 2. persona + model + key
    const persona = getPersona()
    const model = getDefaultModel()
    if (!model) throw new Error('未配置模型，请先在设置页添加模型')

    const apiKey = model.keyId ? getKey(model.keyId) ?? undefined : undefined
    const agent = new Agent(buildAgentConfig(persona, model.modelId, apiKey), {
      llmOpts: { apiKey, baseURL: model.baseUrl },
      toolCtx: { sessionId: sid },
    })

    // 3. 历史 + 当前消息
    const history = listMessages(sid)
    // 存当前用户消息
    addMessage({ sessionId: sid, role: 'user', content: message })

    // 4. Agent.run
    const result = await agent.run(
      {
        messages: [
          ...history.map((m) => ({
            role: m.role === 'tool' ? ('user' as const) : m.role,
            content: m.content,
          })),
          { role: 'user' as const, content: message },
        ],
        runId: sid,
      },
      {
        onText: (text) => emitStream({ type: 'text', text }),
      },
    )

    // 5. 存 assistant 回复
    addMessage({ sessionId: sid, role: 'assistant', content: result.finalText })

    // 6. 结束事件
    emitStream({ type: 'message_stop', stop_reason: 'end_turn' })

    return { runId: sid }
  })

  withHandler<void>('home:cancel', () => {
    // 阶段6 实装 AbortController 透传；骨架先记
    logger.info('[home:cancel] 待 AbortController 接入')
  })
}

void getDb // 预留：未来记忆注入
