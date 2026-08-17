import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { err, isIpcFailure, ok, type IpcResult, IpcErrorThrow } from '@shared/types'
import { logger } from '../logger'

// —— withHandler：所有 ipcMain.handle 统一 try/catch，返回结构化 IpcResult（§11.3）——
// 失败不抛未捕获异常，渲染层据 isIpcFailure 判定并按 retryable 重试。
export type InvokeHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown | Promise<unknown>

export function withHandler<T>(channel: string, handler: InvokeHandler): void {
  ipcMain.handle(channel, async (event, ...args): Promise<IpcResult<T>> => {
    try {
      const data = (await handler(event, ...args)) as T
      return ok(data)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const retryable = isTransient(error)
      const messageKey = error instanceof IpcErrorThrow ? error.messageKey : undefined
      // 分级日志（P3-17）：IpcErrorThrow 是业务正常驳回（环检测/无供应商/提问失效），
      // 非瞬态、非系统故障 → warn 级，不污染错误统计；真异常（非 IpcErrorThrow）
      // 才 error 级。retryable 也作为辅助判据（瞬态=网络/超时等，warn 即可）。
      if (error instanceof IpcErrorThrow || retryable) {
        logger.warn(`[ipc:${channel}] ${message}`)
      } else {
        logger.error(`[ipc:${channel}]`, error)
      }
      return err(`ipc.${channel}`, message, retryable, messageKey)
    }
  })
}

function isTransient(error: unknown): boolean {
  const name = error instanceof Error ? error.name : ''
  const msg = error instanceof Error ? error.message : String(error)
  return (
    name.includes('Network') ||
    /timeout|connection|temporarily|busy|locked/i.test(msg)
  )
}

export { isIpcFailure }
