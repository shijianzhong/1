import { isIpcFailure, type IpcResult } from '@shared/types'

// —— 渲染层 IPC 薄封装（§5.6 + §11.3）——
// 业务调用点只调本模块，window.one.* 不裸用。
// withHandler 返回 IpcResult<T>，unwrap 失败抛错由 TanStack Query onError 兜底。

export class IpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'IpcError'
  }
}

/** 解包 IpcResult，失败抛 IpcError（TanStack Query 自动重试 retryable 错误） */
export function unwrap<T>(result: IpcResult<T>): T {
  if (isIpcFailure(result)) {
    throw new IpcError(result.code, result.message, result.retryable)
  }
  return result.data
}

export const one = window.one
