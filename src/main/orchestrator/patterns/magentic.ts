import type { GraphNode } from '@shared/types'
import type { BuilderContext } from '../models'
import { logger } from '../../logger'

// —— Magentic pattern（§三之三 G + §三之三 K#1）——
// MVP 跳过（proton 未启用 NotImplementedError）。
// 用 groupchat(manager) + handoff 覆盖。
// builder 分发到此只记日志 + 抛降级提示。

export function buildMagentic(node: GraphNode, _bctx: BuilderContext): void {
  logger.warn(
    `[builder:magentic] ${node.id} MVP 跳过，请用 groupchat(manager)+handoff 覆盖`,
  )
  throw new Error(
    `magentic 模式 MVP 未实现，请改用 groupchat(manager)+handoff 覆盖（§三之三 K#1）`,
  )
}
