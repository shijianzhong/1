import { describe, expect, it, beforeEach } from 'vitest'
import {
  APPROVAL_RESPONSE_SESSION,
  clearAllSessionToolApprovals,
  clearSessionToolApprovals,
  grantSessionToolApproval,
  isSessionToolApproved,
  resolveApprovalDecision,
} from './sessionApprovals'

describe('sessionApprovals（本会话允许）', () => {
  beforeEach(() => {
    clearAllSessionToolApprovals()
  })

  it('未放行 → false', () => {
    expect(isSessionToolApproved('sess_1', 'shell_run')).toBe(false)
  })

  it('grant 后同会话同工具 → true', () => {
    grantSessionToolApproval('sess_1', 'shell_run')
    expect(isSessionToolApproved('sess_1', 'shell_run')).toBe(true)
  })

  it('不同会话 / 不同工具互不串', () => {
    grantSessionToolApproval('sess_1', 'shell_run')
    expect(isSessionToolApproved('sess_2', 'shell_run')).toBe(false)
    expect(isSessionToolApproved('sess_1', 'mcp__x__y')).toBe(false)
  })

  it('clearSession 只清该会话', () => {
    grantSessionToolApproval('sess_1', 'shell_run')
    grantSessionToolApproval('sess_2', 'shell_run')
    clearSessionToolApprovals('sess_1')
    expect(isSessionToolApproved('sess_1', 'shell_run')).toBe(false)
    expect(isSessionToolApproved('sess_2', 'shell_run')).toBe(true)
  })

  it('无 sessionId → false', () => {
    grantSessionToolApproval('sess_1', 'shell_run')
    expect(isSessionToolApproved(undefined, 'shell_run')).toBe(false)
  })

  it('APPROVAL_RESPONSE_SESSION 常量稳定（IPC/前端契约）', () => {
    expect(APPROVAL_RESPONSE_SESSION).toBe('approved_session')
  })

  it('resolveApprovalDecision: approved_session → 批准并写入放行表', () => {
    const r = resolveApprovalDecision(APPROVAL_RESPONSE_SESSION, 'sess_1', 'shell_run')
    expect(r.approved).toBe(true)
    expect(isSessionToolApproved('sess_1', 'shell_run')).toBe(true)
  })

  it('resolveApprovalDecision: approved → 批准但不写入放行表', () => {
    const r = resolveApprovalDecision('approved', 'sess_1', 'shell_run')
    expect(r.approved).toBe(true)
    expect(isSessionToolApproved('sess_1', 'shell_run')).toBe(false)
  })

  it('resolveApprovalDecision: denied → 拒绝', () => {
    expect(resolveApprovalDecision('denied', 'sess_1', 'shell_run').approved).toBe(false)
  })
})
