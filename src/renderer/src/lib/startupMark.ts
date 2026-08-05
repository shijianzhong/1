/**
 * 渲染层启动埋点：写入 window.__ONE_STARTUP__，并尽量 flush 到主进程 startup.log。
 * IPC 尚未就绪时先攒队列，window.one 出现后再冲刷。
 */

declare global {
  interface Window {
    __ONE_STARTUP__?: {
      origin: number
      wallOrigin: number
      marks: Array<{ phase: string; t: number; wall: number; detail?: unknown }>
      mark: (phase: string, detail?: Record<string, unknown>) => number
    }
  }
}

type Queued = { phase: string; rendererT: number; detail?: Record<string, unknown> }

const queue: Queued[] = []
let flushing = false
let flushTimer: ReturnType<typeof setTimeout> | null = null

function localMark(phase: string, detail?: Record<string, unknown>): number {
  if (window.__ONE_STARTUP__?.mark) {
    return window.__ONE_STARTUP__.mark(phase, detail)
  }
  // boot-mark.js 未加载时的兜底
  const t = performance.now()
  return t
}

function enqueue(phase: string, rendererT: number, detail?: Record<string, unknown>): void {
  queue.push({ phase, rendererT, detail })
  scheduleFlush()
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flush()
  }, 0)
}

async function flush(): Promise<void> {
  if (flushing) return
  if (typeof window.one?.system?.startupMark !== 'function') {
    // preload 可能尚未注入：稍后重试
    if (queue.length > 0) {
      flushTimer = setTimeout(() => {
        flushTimer = null
        void flush()
      }, 50)
    }
    return
  }
  flushing = true
  try {
    while (queue.length > 0) {
      const item = queue.shift()!
      try {
        await window.one.system.startupMark({
          phase: item.phase,
          rendererT: item.rendererT,
          detail: item.detail,
        })
      } catch {
        // 诊断日志失败不阻断启动
      }
    }
  } finally {
    flushing = false
    if (queue.length > 0) scheduleFlush()
  }
}

/** 记一个阶段点，并异步写入 userData/logs/startup.log */
export function startupMark(phase: string, detail?: Record<string, unknown>): void {
  const rendererT = localMark(phase, detail)
  enqueue(phase, rendererT, detail)
}

/** 把 boot-mark.js 已累积、尚未上报的 marks 一次性冲刷 */
export function flushBootMarks(): void {
  const boot = window.__ONE_STARTUP__
  if (!boot) return
  for (const m of boot.marks) {
    enqueue(m.phase, m.t, m.detail as Record<string, unknown> | undefined)
  }
}
