import type { ApiFormat } from '@shared/types'
import { getClient } from './retry'

// —— L2 精炼压缩函数（§三之三 D + 铁律21）——
// home / orchestrate 共用：用默认 provider 跑一次 LLM，把会话压成 ≤300 字摘要供 L2 落盘。
// 抽到共享模块以防两路径精炼语义漂移。

/**
 * 构造 L2 精炼函数。
 * @param modelId 默认 provider 的 modelId
 * @param apiKey/baseURL/authHeader/apiFormat 默认 provider 凭据
 * @returns (text) => Promise<string> 输入会话文本，输出 ≤300 字摘要
 */
export function makeCompressFn(
  modelId: string,
  apiKey?: string,
  baseURL?: string,
  authHeader?: string,
  apiFormat?: ApiFormat,
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
