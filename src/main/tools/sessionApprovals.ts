// —— 会话级工具审批放行（「本会话允许」）——
// 用户在 ApprovalCard 点「本会话允许」后，同一 sessionId 下同名 always 工具
// 跳过后续 onApprove 弹窗。危险命令仍走 preCheck 硬拦，不受本表影响。
// 内存态：进程退出即清空；不写盘（个人桌面工具，会话级信任足够）。

import type { ApprovalDecision } from './registry'

const approved = new Map<string, Set<string>>()

/** 本会话放行某工具（如 shell_run / mcp__*） */
export function grantSessionToolApproval(sessionId: string, toolName: string): void {
  if (!sessionId || !toolName) return
  let set = approved.get(sessionId)
  if (!set) {
    set = new Set()
    approved.set(sessionId, set)
  }
  set.add(toolName)
}

/** 该会话是否已放行此工具 */
export function isSessionToolApproved(sessionId: string | undefined, toolName: string): boolean {
  if (!sessionId) return false
  return approved.get(sessionId)?.has(toolName) ?? false
}

/** 清除某会话的全部放行（会话删除时调用） */
export function clearSessionToolApprovals(sessionId: string): void {
  approved.delete(sessionId)
}

/** 测试用：清空全部 */
export function clearAllSessionToolApprovals(): void {
  approved.clear()
}

/** orchestrate:respond 的「本会话允许」应答值（与「允许」approved /「拒绝」denied 并列） */
export const APPROVAL_RESPONSE_SESSION = 'approved_session'

/**
 * 把用户审批应答转成 executeTool 闸门结果。
 * `approved_session` → 写入会话放行表并视为批准；`approved` → 仅本次；其它 → denied。
 * 返回判别联合 ApprovalDecision（approved=false 时 reason 必填 'denied'，供 registry 分流 i18n key）。
 */
export function resolveApprovalDecision(
  response: string,
  sessionId: string | undefined,
  toolName: string,
): ApprovalDecision {
  if (response === APPROVAL_RESPONSE_SESSION) {
    if (sessionId) grantSessionToolApproval(sessionId, toolName)
    return { approved: true, reason: 'approved_session' }
  }
  if (response === 'approved') return { approved: true, reason: 'approved' }
  return { approved: false, reason: 'denied' }
}

/**
 * 把 waitForUserInput 的 rejection（超时/取消/被顶替）映射成审批决议的 reason。
 * 用于 onApprove 桥的 catch：吞错返回 falsy 带区分字段（铁律11 不抛 → 不死循环），
 * 供 registry 闸门选 errors.tools.approval_timeout / approval_aborted / approval_denied。
 *（CODE_AUDIT 断言 5.5：旧实现 reason 硬编码 'timeout or cancelled' 且 registry 不读，
 *  超时/取消/拒绝全混 approval_denied。）
 *
 * - user_input_timeout → 'timeout'（30min 无作答）
 * - aborted / rejectUserInputsForRun 的 reason 含 'abort' → 'aborted'（运行被取消/被新 run 顶替）
 * - 其它 → 'aborted'（保守：非超时即视为运行中断，非用户主动拒绝）
 */
export function rejectionToApprovalReason(err: unknown): 'timeout' | 'aborted' | 'denied' {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg === 'user_input_timeout' || msg.includes('timeout')) return 'timeout'
  if (msg === 'aborted' || msg.toLowerCase().includes('abort')) return 'aborted'
  return 'aborted'
}
