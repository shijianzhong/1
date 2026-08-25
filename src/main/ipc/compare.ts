import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import { z } from 'zod'
import { IpcErrorThrow } from '@shared/types'
import type { CompareStreamEvent, LlmRequest, ProviderModels } from '@shared/types'
import { withHandler } from './handler'
import { getClient } from '../llm/retry'
import { getProvider, resolveProviderCredentials } from '../storage/models'
import { logger } from '../logger'

// —— 多模型并行对比（亮点③）——
// 轻量独立通道：不复用 home:chat 完整链路（L1 压缩/意图路由/mentions 分流），
// 仅按所选 ModelConfig 各自解析凭据、并发跑一路 stream，增量经 chat:compare:stream 推送（带 modelId 归位）。
// 前端按 compareId 关联一次对比、按 modelId 把各路增量落到对应栏。

const COMPARE_STREAM_CHANNEL = 'chat:compare:stream'
const MAX_MODELS = 6
/** maxTokens 缺省 16384（铁律8：Anthropic 强制，缺省 16384） */
const DEFAULT_MAX_TOKENS = 16384
/** enabled thinking 预算（< maxTokens，≥1024） */
const THINKING_BUDGET = 4096

interface CompareInput {
  prompt: string
  /** 所选 ModelConfig.id 列表（渲染层经 models:list 多选） */
  modelIds: string[]
  system?: string
}

function emitCompare(event: CompareStreamEvent): void {
  // 全局广播到首个窗口（与 home/orchestrate 的 emitStream 同构：getAllWindows()[0]）
  const win = BrowserWindow.getAllWindows()[0] ?? null
  win?.webContents.send(COMPARE_STREAM_CHANNEL, event)
}

export function registerCompareHandlers(): void {
  withHandler<{ compareId: string; modelIds: string[] }>('chat:compare', async (_e, input) => {
    const parsed = z
      .object({
        prompt: z.string().min(1).max(20000),
        modelIds: z.array(z.string().min(1)).min(1).max(MAX_MODELS),
        system: z.string().max(20000).optional(),
      })
      .parse(input)
    const compareId = `cmp_${randomUUID()}`
    // 立即返回 compareId 让前端建立关联；各路增量经 stream 异步推送，
    // 不阻塞 invoke（避免长连接期间渲染层空等）。
    void runCompare(compareId, parsed).catch((e) => {
      logger.error('[compare] 运行异常', e)
    })
    return { compareId, modelIds: parsed.modelIds }
  })
}

async function runCompare(compareId: string, input: CompareInput): Promise<void> {
  const tasks = input.modelIds.map((configId) =>
    runOneModel(compareId, configId, input.prompt, input.system),
  )
  // 各路相互隔离：单路失败不影响其余（Promise.allSettled）
  await Promise.allSettled(tasks)
  emitCompare({ type: 'complete', compareId })
}

async function runOneModel(
  compareId: string,
  configId: string,
  prompt: string,
  system?: string,
): Promise<void> {
  const sep = configId.indexOf(':')
  const providerId = sep > 0 ? configId.slice(0, sep) : configId
  const usage = (sep > 0 ? configId.slice(sep + 1) : 'default') as keyof ProviderModels
  const provider = getProvider(providerId)
  if (!provider) {
    emitCompare({
      type: 'error',
      compareId,
      modelId: configId,
      error: `provider not found: ${providerId}`,
      messageKey: 'errors:compare.provider_not_found',
    })
    return
  }
  const creds = resolveProviderCredentials(provider, usage)
  const modelId = creds.modelId
  if (!modelId) {
    emitCompare({
      type: 'error',
      compareId,
      modelId: configId,
      error: `model not found for usage ${usage} in provider ${providerId}`,
      messageKey: 'errors:compare.model_not_found',
    })
    return
  }
  const client = getClient(modelId, {
    apiKey: creds.apiKey,
    baseURL: creds.baseURL,
    authHeader: creds.authHeader,
    apiFormat: creds.apiFormat,
  })

  emitCompare({
    type: 'start',
    compareId,
    modelId: configId,
    modelLabel: `${provider.name} · ${modelId}`,
  })

  const req: LlmRequest = {
    model: modelId,
    system,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: DEFAULT_MAX_TOKENS,
    // thinking 按 provider 开关（与 home:chat 一致：启用则 enabled，预算 4096）
    thinking: provider.enableThinking ? { type: 'enabled', budgetTokens: THINKING_BUDGET } : undefined,
    onDelta: (delta) =>
      emitCompare({ type: 'delta', compareId, modelId: configId, delta }),
  }

  try {
    const res = await client.stream(req)
    const textLen = res.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .reduce((n, b) => n + b.text.length, 0)
    emitCompare({
      type: 'done',
      compareId,
      modelId: configId,
      stopReason: res.stopReason,
      textLen,
    })
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    // 业务性驳回（如 IpcErrorThrow：供应商无 key）带 messageKey；其余落通用 message
    const messageKey =
      e instanceof IpcErrorThrow ? e.messageKey : 'errors:compare.run_failed'
    emitCompare({
      type: 'error',
      compareId,
      modelId: configId,
      error: errMsg,
      messageKey,
    })
  }
}
