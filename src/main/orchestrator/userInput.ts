import { randomUUID } from 'node:crypto'
import { logger } from '../logger'

// —— HITL 用户输入等待队列（对照原框架 request_info 的外部应答路由）——
// ask_user / 工具审批挂起的 Promise 存这里，orchestrate:respond IPC 按 requestId 找回并 resolve。
// home 与 orchestrate 两条 IPC 通道共用本模块。
//
// 作用域：每条挂起带 runId；结束/取消时按 run 清理，避免跨通道整池误伤（PROJECT_REVIEW 风险 3）。

const TIMEOUT_MS = 30 * 60 * 1000 // 30min 无作答超时（工具侧转错误 JSON，不抛异常）

interface PendingUserInput {
  resolve: (response: string) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  meta: { nodeId: string; question: string }
  runId: string
  abortListener?: () => void
}

const pending = new Map<string, PendingUserInput>()

export function newRequestId(): string {
  return `req_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export function newRunId(prefix = 'run'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

/**
 * 挂起等待用户作答。
 * - 正常：orchestrate:respond → resolveUserInput → resolve(answer)
 * - 超时：30min 无作答 → reject('user_input_timeout')
 * - 取消：signal abort / rejectUserInputsForRun → reject('aborted')
 * 调用方（ask_user 工具）把 rejection 转错误 JSON 返回给 LLM（铁律11，不抛）。
 */
export function waitForUserInput(
  requestId: string,
  meta: { nodeId: string; question: string },
  signal?: AbortSignal,
  runId = 'default',
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup(requestId)
      reject(new Error('user_input_timeout'))
    }, TIMEOUT_MS)
    // 30min 定时器不拖住进程退出（vitest/脚本场景）；Electron 主进程事件循环
    // 由 app 生命周期维持，unref 不影响运行期行为
    timer.unref?.()

    const entry: PendingUserInput = { resolve, reject, timer, meta, runId }

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer)
        reject(new Error('aborted'))
        return
      }
      const onAbort = (): void => {
        cleanup(requestId)
        reject(new Error('aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      entry.abortListener = () => signal.removeEventListener('abort', onAbort)
    }

    pending.set(requestId, entry)
    logger.info(
      `[userInput] 等待用户作答 ${requestId} run=${runId}（${meta.nodeId}: ${meta.question.slice(0, 40)}）`,
    )
  })
}

/** 用户已作答（orchestrate:respond 调用）。requestId 不存在/已结算 → false。 */
export function resolveUserInput(requestId: string, response: string): boolean {
  const entry = pending.get(requestId)
  if (!entry) return false
  cleanup(requestId)
  entry.resolve(response)
  logger.info(`[userInput] 用户已作答 ${requestId}`)
  return true
}

/** 驳回指定 run 的挂起提问。返回驳回数。 */
export function rejectUserInputsForRun(runId: string, reason: string): number {
  let count = 0
  for (const [id, entry] of [...pending]) {
    if (entry.runId !== runId) continue
    cleanup(id)
    entry.reject(new Error(reason))
    count += 1
  }
  if (count > 0) logger.info(`[userInput] 驳回 run=${runId} 的 ${count} 个挂起提问：${reason}`)
  return count
}

/**
 * 取消运行/退出时驳回全部挂起提问（进程退出 / 测试清理）。
 * 运行结束路径请改用 rejectUserInputsForRun，避免跨通道误伤。
 */
export function rejectAllUserInputs(reason: string): number {
  const count = pending.size
  for (const [id, entry] of [...pending]) {
    cleanup(id)
    entry.reject(new Error(reason))
  }
  if (count > 0) logger.info(`[userInput] 驳回全部 ${count} 个挂起提问：${reason}`)
  return count
}

function cleanup(requestId: string): void {
  const entry = pending.get(requestId)
  if (!entry) return
  clearTimeout(entry.timer)
  entry.abortListener?.()
  pending.delete(requestId)
}

/** 测试用：清空全部挂起（不清 timer 会拖住进程） */
export function clearUserInputsForTest(): void {
  rejectAllUserInputs('test_cleanup')
}
