// —— child-process spawn 管道（docs/VECTOR_KB_PLAN.md §二，铁律23 同类）——
//
// 逐字复刻 src/main/tools/builtin/skillScript.ts 的 runScript async spawn 纪律：
//   detached:true（新进程组长，kill 时连同孙进程一并杀）、timer→killProcessGroup、
//   AbortSignal addEventListener+removeEventListener 清理、stdout cap、stderr tail。
// 差异：持久单 worker（懒 spawn 一次、跨 batch 复用）+ stdio JSON 行协议
//   （而非一次性脚本执行）。embedding 调用可能产大量向量数据，stdout cap 调到 64MB。
//
// 失败语义（配合降级链）：worker 崩/timeout/abort → reject 进行中 batch →
//   返回 null 项 → 该 chunk vec=NULL（只词法命中，功能不瘫痪）。

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { killProcessGroup } from '../tools/processKill'
import { getKbModelDir, getKbWorkerModulesDir, getKbWorkerScriptPath } from '../storage/paths'
import { logger } from '../logger'

const EMBED_TIMEOUT_MS = 120_000 // 首批含模型加载，比 skill script 60s 宽
const STDOUT_MAX_BYTES = 64 * 1024 * 1024 // embedding 调到 64MB（vs skill 256KB）
const STDERR_KEEP_CHARS = 8_000

interface PendingBatch {
  resolve: (vectors: (Float32Array | null)[]) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
  texts: string[]
  n: number
}

interface WorkerState {
  child: ChildProcessWithoutNullStreams
  pending: Map<string, PendingBatch>
  buf: string
  stderr: string
  stdoutBytes: number
  failed: boolean
}

let worker: WorkerState | null = null
let batchSeq = 0

/** 启动 worker 子进程（懒：首次 embed 时调，跨 batch 复用） */
function ensureWorker(): WorkerState {
  if (worker && !worker.failed) return worker
  const scriptPath = getKbWorkerScriptPath()
  const modulesDir = getKbWorkerModulesDir()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    MODEL_DIR: getKbModelDir(),
    MODEL_ID: DEFAULT_MODEL_ID,
    WORKER_MODULES_DIR: modulesDir,
    KB_REMOTE_HOST: 'https://hf-mirror.com/',
  }
  const child = spawn(process.execPath, [scriptPath], {
    cwd: modulesDir || undefined,
    env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const state: WorkerState = {
    child,
    pending: new Map(),
    buf: '',
    stderr: '',
    stdoutBytes: 0,
    failed: false,
  }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    state.buf += chunk
    state.stdoutBytes += Buffer.byteLength(chunk)
    if (state.stdoutBytes > STDOUT_MAX_BYTES) {
      // 防异常 worker GB 级输出撑爆内存
      state.failed = true
      failAll(state, new Error('stdout_limit_exceeded'))
      killProcessGroup(child)
      return
    }
    let nl: number
    while ((nl = state.buf.indexOf('\n')) >= 0) {
      const line = state.buf.slice(0, nl).trim()
      state.buf = state.buf.slice(nl + 1)
      if (!line) continue
      handleWorkerLine(state, line)
    }
  })
  child.stderr.on('data', (d: Buffer) => {
    state.stderr = (state.stderr + d.toString()).slice(-STDERR_KEEP_CHARS)
  })
  child.on('error', (e) => {
    state.failed = true
    failAll(state, e)
  })
  child.on('close', (code) => {
    state.failed = true
    // 进行中的 batch 全 reject（worker 退出 → 该批响应不会回）
    failAll(state, new Error(`worker_exit_${code ?? 'unknown'}`))
    if (worker === state) worker = null
  })
  worker = state
  return state
}

/** 解析 worker stdout JSON 行，分发到对应 pending batch */
function handleWorkerLine(state: WorkerState, line: string): void {
  let msg: { id?: string; vectors?: number[][] | null[]; error?: string; message?: string }
  try {
    msg = JSON.parse(line)
  } catch {
    return // 非 JSON 行（不应出现，忽略）
  }
  const id = msg.id
  if (!id) return
  const pending = state.pending.get(id)
  if (!pending) return // 已 timeout/abort 取消，忽略迟到响应
  clearTimeout(pending.timer)
  state.pending.delete(id)
  if (msg.error) {
    // init/embed 失败 → 该批全 null（降级：只词法命中）
    logger.warn(`[embed-worker] batch ${id} error: ${msg.error} ${msg.message ?? ''}`)
    pending.resolve(pending.texts.map(() => null))
    // init 失败（worker 退出/respawn 信号）→ 标 failed，下批重建
    if (msg.error === 'init_failed' || msg.error === 'uncaught') {
      state.failed = true
      killProcessGroup(state.child)
    }
    return
  }
  // vectors: number[][] —— 转回 Float32Array；null 项保持 null
  const vecs = (msg.vectors ?? []) as (number[] | null)[]
  const out: (Float32Array | null)[] = pending.texts.map((_, i) => {
    const v = vecs[i]
    if (!v || !Array.isArray(v)) return null
    return Float32Array.from(v)
  })
  pending.resolve(out)
}

/** 把所有 pending batch reject（worker 崩/退出/超上限） */
function failAll(state: WorkerState, e: Error): void {
  for (const [id, pending] of state.pending) {
    clearTimeout(pending.timer)
    pending.reject(e)
    state.pending.delete(id)
  }
}

/** 默认模型 id（spike/正式统一改此单点）。
 * 中文默认：multilingual-e5-small（384 维，英+中，WASM 友好，量化 ~23MB）。
 * 理由：方案 §二:61/72 要求中文默认，MiniLM 是英文（KB_CODE_REVIEW P0-2 偏差）。
 * e5 系是非对称检索——query 加 "query: "、corpus 加 "passage: " 前缀，已由
 * worker-embed.cjs 在 isE5 时按 kind 自动加（KB_CODE_REVIEW 复核 P2 项落地）。
 * 升级 bge-m3（1024 维）留作 P1 中文质量 spike 验证后选项——届时同步改 DIM +
 * vec_dim 漂移重嵌链路；bge-m3 不用 query 前缀（优于 e5）。 */
export const DEFAULT_MODEL_ID = 'Xenova/multilingual-e5-small'

/** e5 非对称检索的两种角色：ingestion 用 passage，search query 用 query。 */
export type EmbedKind = 'query' | 'passage'

/** 默认模型维度（store.ts vec_dim 比对、db.ts 漂移自检用） */
export const DEFAULT_MODEL_DIM = 384

/**
 * 批量 embed：调 worker 子进程，返回与 texts 等长的向量数组（null = 该条未向量化）。
 * 失败条目返回 null，**绝不抛异常**（配合降级链：调用方据 null 走词法兜底）。
 *
 * @param kind e5 非对称检索角色：ingestion 语料传 `'passage'`，search query 传 `'query'`。
 *   非 e5 模型（bge 等）忽略；不传则 worker 不加前缀（legacy，仅当模型确实无前缀约定时）。
 */
export function embedBatchViaWorker(
  texts: string[],
  signal?: AbortSignal,
  kind?: EmbedKind,
): Promise<(Float32Array | null)[]> {
  if (texts.length === 0) return Promise.resolve([])
  const state = ensureWorker()
  const id = `batch_${++batchSeq}`
  const task = new Promise<(Float32Array | null)[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      // 单批超时：只 reject 这批，不杀整个 worker（其它批可能正常）
      state.pending.delete(id)
      reject(new Error('timeout'))
      // 但若这批卡住致 worker 不响应，下批会再超时 → 届时由 close/fail 重建
    }, EMBED_TIMEOUT_MS)
    state.pending.set(id, { resolve, reject, timer, texts, n: texts.length })
    const onAbort = (): void => {
      clearTimeout(timer)
      state.pending.delete(id)
      reject(signal?.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    // 写入请求（worker 逐行读）；kind 透传给 worker 决定 e5 前缀
    const line = JSON.stringify({ id, texts, kind }) + '\n'
    try {
      state.child.stdin.write(line)
    } catch (e) {
      clearTimeout(timer)
      state.pending.delete(id)
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
  return task.catch((e) => {
    // timeout/abort/write 失败 → 该批全 null（降级，不抛）
    logger.warn(`[embed-worker] batch ${id} failed: ${e.message}, degrading to null`)
    return texts.map(() => null)
  })
}

/** 终止 worker（app before-quit 调用，best-effort） */
export function terminateEmbedWorker(): void {
  if (!worker) return
  const w = worker
  worker = null
  w.failed = true
  try {
    // EOF（关 stdin）让 worker 自然退出，2s 宽限后强杀
    w.child.stdin.end()
    setTimeout(() => killProcessGroup(w.child), 2000)
  } catch {
    killProcessGroup(w.child)
  }
  failAll(w, new Error('terminating'))
}
