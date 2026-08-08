import type { LlmToolDef } from '@shared/types'

/**
 * 按资产级白名单过滤工具快照（PROJECT_REVIEW P1）。
 * allowlist undefined / 空数组 = 不限制（保持当前全量快照语义）。
 */
export function filterToolsByAllowlist(
  tools: LlmToolDef[],
  allowlist?: string[] | null,
): LlmToolDef[] {
  if (!allowlist || allowlist.length === 0) return tools
  const allowed = new Set(allowlist)
  return tools.filter((t) => allowed.has(t.name))
}
