import { isIpcFailure, normalizeI18nKey, type IpcResult } from '@shared/types'

// —— 渲染层 IPC 薄封装（§5.6 + §11.3）——
// 业务调用点只调本模块，window.one.* 不裸用。
// withHandler 返回 IpcResult<T>，unwrap 失败抛错由 TanStack Query onError 兜底。

export class IpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly messageKey?: string,
  ) {
    super(message)
    this.name = 'IpcError'
  }
}

/** 解包 IpcResult，失败抛 IpcError（TanStack Query 自动重试 retryable 错误） */
export function unwrap<T>(result: IpcResult<T>): T {
  if (isIpcFailure(result)) {
    throw new IpcError(
      result.code,
      result.message,
      result.retryable,
      result.messageKey ? normalizeI18nKey(result.messageKey) : undefined,
    )
  }
  return result.data
}

export const one = window.one

/**
 * 从错误对象提取用户可见消息：优先用 messageKey 做 i18n 查询，无则降级到 message。
 * 使用方式：errorMessage(e, t) → string
 * 兼容历史点号 key（errors.foo → errors:foo）。
 */
export function errorMessage(
  e: unknown,
  t?: (key: string, opts?: { defaultValue?: string }) => string,
): string {
  if (e instanceof IpcError && e.messageKey && t) {
    return t(normalizeI18nKey(e.messageKey), { defaultValue: e.message })
  }
  return e instanceof Error ? e.message : String(e)
}
