// —— 带超时的 fetch 共享 helper（web 工具与 KB URL 摄取共用，review #10）——
// 此前 web.ts fetchText 与 vector/extract.ts extractFromUrl 各持一份
// timeout + AbortController + 调用方 signal 链接逻辑，逐字重复会漂移。

export interface FetchWithTimeoutOptions {
  /** 超时毫秒（到时 abort，reason=Error('timeout')） */
  timeoutMs: number
  /** 调用方取消信号（链接进内部 AbortController） */
  signal?: AbortSignal
  headers?: Record<string, string>
}

/**
 * fetch + 超时中止 + 调用方 signal 链接。返回原始 Response（res.ok 由调用方判定——
 * web 工具要 4xx/5xx 分流，KB 摄取统一转结构化错误，语义不同故不在此层收口）。
 * 超时/中止/网络错误都 reject；finally 保证 timer 与 abort 监听清理。
 */
export async function fetchWithTimeout(
  url: string,
  opts: FetchWithTimeoutOptions,
): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), opts.timeoutMs)
  const onAbort = (): void => ctrl.abort(opts.signal?.reason ?? new Error('aborted'))
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await fetch(url, { headers: opts.headers, signal: ctrl.signal, redirect: 'follow' })
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}
