// —— KB 本地模型运行时下载（docs/VECTOR_KB_PLAN.md §二:87 + §八 P4）——
//
// slim 包出厂不带模型权重，/kb 页「下载模型」按钮触发本模块，
// 从 hf-mirror.com 下载 Xenova/multilingual-e5-small 到 getKbModelDir()（userData/kb-models）。
//
// 逻辑复制自 scripts/fetch-kb-model.mjs（full 包打包前跑的脚本），区别：
//   - 目标目录是 getKbModelDir()（运行时可写），非 build/kb-models（打包期）
//   - 加进度流 kb:downloadModel:progress（每文件 progress + done/error）
//   - 不走 console.log，走 logger + webContents.send
//
// 幂等：已存在非空文件跳过；404 容忍（不同模型仓文件集不同，如 e5 用 sentencepiece.bpe.model）。

import { BrowserWindow } from 'electron'
import { mkdir, stat, rename, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { getKbModelDir } from '../storage/paths'
import { logger } from '../logger'
import type { KbDownloadModelProgressEvent } from '@shared/types'

// 与 worker-client DEFAULT_MODEL_ID 单点一致（换模型改 worker-client，此处跟随）
const MODEL_ID = 'Xenova/multilingual-e5-small'
const HOST = 'https://hf-mirror.com'
// e5-small 最小推理集（与 scripts/fetch-kb-model.mjs FILES 一致）
const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.txt',
  'sentencepiece.bpe.model',
  'onnx/model_quantized.onnx',
]

const PROGRESS_CHANNEL = 'kb:downloadModel:progress'

/** 单文件大小上限（review #15）：e5 全套 ~23MB，异常源/重定向到超大文件时防呆 */
const MAX_MODEL_FILE_BYTES = 200 * 1024 * 1024
/** 单文件 fetch 重试（review #12）：5xx/网络抖动退避，404/4xx 终态不重试 */
const FETCH_ATTEMPTS = 3
const FETCH_BASE_DELAY_MS = 1000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 单文件下载带退避重试。裸 fetch 一次 503/抖动就杀掉整个模型下载序列太脆。
 * 不复用 llm/retry.ts：其 isRetryable 是 LLM SDK 错误形态（APIError instanceof /
 * 网关关键词），与裸 fetch 的 Response/网络错误不同构，各自保持简单。
 */
async function fetchWithRetry(url: string): Promise<Response> {
  let lastErr: Error = new Error('fetch failed')
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' })
      // ok / 404 / 4xx 都是终态（404 由调用方容忍跳过），只有 5xx 重试
      if (res.ok || res.status < 500) return res
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e))
    }
    if (attempt < FETCH_ATTEMPTS - 1) {
      const delay = FETCH_BASE_DELAY_MS * 2 ** attempt
      logger.warn(`[kb-download] fetch 重试 ${attempt + 1}/${FETCH_ATTEMPTS - 1}，${delay}ms 后`, lastErr.message)
      await sleep(delay)
    }
  }
  throw lastErr
}

/** 流式落盘到 .part 再 rename（review #13），超大小上限中止（review #15） */
async function streamToFile(body: ReadableStream, dest: string): Promise<void> {
  // 先写 .part 再原子 rename：中途崩溃/失败不留半截目标文件——否则
  // 「已存在非空即跳过」的幂等会把半截文件当已完成，模型永久损坏无法自愈。
  const part = `${dest}.part`
  let bytes = 0
  // res.body 是 DOM ReadableStream；Readable.fromWeb 要 Node web stream 类型，
  // 经 unknown 断言避免两套 ReadableStream lib 冲突
  const src = Readable.fromWeb(body as unknown as import('node:stream/web').ReadableStream)
  src.on('data', (chunk: Buffer) => {
    bytes += chunk.length
    if (bytes > MAX_MODEL_FILE_BYTES) {
      src.destroy(new Error(`model file exceeds ${MAX_MODEL_FILE_BYTES} bytes`))
    }
  })
  try {
    await pipeline(src, createWriteStream(part))
    await rename(part, dest)
  } catch (e) {
    await unlink(part).catch(() => {})
    throw e
  }
}

function getMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

function emitProgress(ev: KbDownloadModelProgressEvent): void {
  getMainWindow()?.webContents.send(PROGRESS_CHANNEL, ev)
}

/**
 * 下载 KB 嵌入模型到 getKbModelDir()。
 * 进度经 kb:downloadModel:progress channel 推送（每文件 progress + done/error）。
 * 幂等：重跑跳过已存在非空文件。
 */
export async function downloadKbModel(): Promise<void> {
  const outDir = getKbModelDir()
  const modelDir = join(outDir, MODEL_ID)
  await mkdir(modelDir, { recursive: true })

  for (let i = 0; i < FILES.length; i++) {
    const f = FILES[i]
    const dest = join(modelDir, f)
    try {
      // 已存在且非空 → 跳过（幂等）
      if (existsSync(dest)) {
        const st = await stat(dest).catch(() => null)
        if (st && st.size > 0) {
          emitProgress({ type: 'progress', file: f, done: i + 1, total: FILES.length })
          continue
        }
      }
      await mkdir(dirname(dest), { recursive: true })
      const url = `${HOST}/${MODEL_ID}/resolve/main/${f}`
      const res = await fetchWithRetry(url)
      if (!res.ok) {
        // 404 = 该模型仓无此文件（不同模型文件集不同）→ 跳过不报错
        if (res.status === 404) {
          emitProgress({ type: 'progress', file: f, done: i + 1, total: FILES.length })
          continue
        }
        throw new Error(`fetch ${f}: HTTP ${res.status}`)
      }
      if (!res.body) throw new Error(`fetch ${f}: empty body`)
      // onnx 二进制走流式落盘；文本小文件也走流（统一路径，省分支）
      await streamToFile(res.body as unknown as ReadableStream, dest)
      emitProgress({ type: 'progress', file: f, done: i + 1, total: FILES.length })
    } catch (e) {
      logger.warn(`[kb-download] ${f} 下载失败: ${e instanceof Error ? e.message : e}`)
      emitProgress({
        type: 'error',
        file: f,
        done: i,
        total: FILES.length,
        message: e instanceof Error ? e.message : String(e),
      })
      throw e
    }
  }
  emitProgress({ type: 'done', file: '', done: FILES.length, total: FILES.length })
  logger.info(`[kb-download] 完成 → ${modelDir}`)
}
