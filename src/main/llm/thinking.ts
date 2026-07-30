import type { ApiFormat, ThinkingConfig } from '@shared/types'
import { logger } from '../logger'

/**
 * 根据模型 ID 和 API 格式解析 thinking 配置。
 *
 * 策略：用户显式开启 enableThinking 时，按 API 协议决定是否传参。
 * 不用模型名白名单 — 中转代理可能代理任意模型，白名单会误杀。
 *
 * - 非 anthropic 协议：不传 thinking（OpenAI 等协议无此参数）
 * - Opus 4.7/4.8/Opus 5：用 { type: 'adaptive' }（不再支持 budget_tokens）
 * - 其他所有模型（含 Claude 4 系列、中转代理的 DeepSeek 等）：{ type: 'enabled', budget_tokens: 4096 }
 *   - 若中转不支持 thinking，API 返回 400，retry 层兜底不重试（BadRequestError 不重试）
 *   - 若中转支持 thinking 转译，则正常生效
 */
export function resolveThinkingConfig(
  modelId: string,
  apiFormat: ApiFormat | undefined,
  enableThinking: boolean | undefined,
): ThinkingConfig | undefined {
  if (!enableThinking) return undefined

  // 非 anthropic 协议不传 thinking 参数
  if (apiFormat && apiFormat !== 'anthropic') {
    logger.info('[thinking] 已禁用：非 anthropic 协议', apiFormat)
    return undefined
  }

  const id = modelId.toLowerCase()

  // Opus 4.7 / 4.8 / Opus 5 支持 adaptive thinking（不再支持 budget_tokens）
  if (/opus-?4-[78]|opus-?5/.test(id)) {
    return { type: 'adaptive' }
  }

  // 兜底：用户开启了 thinking + anthropic 协议 → 统一用 enabled + budget_tokens
  // 不再用模型名白名单限制，避免中转代理的非 Claude 模型被误杀
  return { type: 'enabled', budgetTokens: 4096 }
}
