import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { err, isIpcFailure, ok, type IpcResult } from '@shared/types'
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
      logger.error(`[ipc:${channel}]`, error)
      return err(`ipc.${channel}`, message, retryable)
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
