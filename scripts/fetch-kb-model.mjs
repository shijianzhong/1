// —— 下载 KB 嵌入模型到 build/kb-models（full 包打包前跑，不入 git）——
//
// 用途：electron-builder.full.yml 的 extraResources 把 build/kb-models 随包 ship，
// 首启复制进 userData/kb-models，离线即用。slim 包不跑此脚本（运行时 worker 从 hf-mirror 下载）。
//
// 下载 Xenova/multilingual-e5-small（384 维，英+中，中文默认；与 worker-client
// DEFAULT_MODEL_ID 一致）的最小推理集：
//   config.json / tokenizer.json / tokenizer_config.json / special_tokens_map.json / vocab.txt
//   + onnx/model_quantized.onnx（量化权重，体积小、WASM 友好）
// 镜像走 hf-mirror.com（国内可访问）。worker 的 customCache 按 key 抽 <file> 映射到磁盘，
// 故 build/kb-models 结构须与 HF 仓一致（config.json 在根，onnx/ 子目录）。
//
// 用法：node scripts/fetch-kb-model.mjs   （package:full 自动调）
//   --model-id <id>   换模型（默认 Xenova/multilingual-e5-small）
//   --out <dir>       换输出目录（默认 build/kb-models）
//   --host <url>      换镜像（默认 https://hf-mirror.com）

import { mkdir, writeFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const MODEL_ID = argValue('--model-id', 'Xenova/multilingual-e5-small')
const OUT_DIR = normalize(argValue('--out', 'build/kb-models'))
const HOST = argValue('--host', 'https://hf-mirror.com').replace(/\/$/, '')

// 须下载的文件（相对 MODEL_ID 仓根）。
// e5-small 用 sentencepiece.bpe.model（非 vocab.txt）；tokenizer.json 已自含但保留
// sentencepiece 作 fallback。MiniLM 用 vocab.txt——按模型实际仓文件，缺则跳过不报错。
const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.txt',
  'sentencepiece.bpe.model',
  'onnx/model_quantized.onnx',
]

function argValue(flag, def) {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}

async function fetchFile(relPath) {
  const url = `${HOST}/${MODEL_ID}/resolve/main/${relPath}`
  const dest = join(OUT_DIR, MODEL_ID, relPath)
  // 已存在且非空 → 跳过（幂等，重跑不重复下）
  if (existsSync(dest)) {
    const st = await stat(dest).catch(() => null)
    if (st && st.size > 0) {
      console.log(`  ✓ ${relPath} (cached ${Math.round(st.size / 1024)}KB)`)
      return
    }
  }
  await mkdir(dirname(dest), { recursive: true })
  console.log(`  ↓ ${relPath} from ${url}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) {
    // 404 = 该模型仓无此文件（不同模型文件集不同，如 e5 用 sentencepiece.bpe.model
  // 非 vocab.txt）→ 跳过不报错；其它错误（5xx/网络）→ 抛
    if (res.status === 404) {
      console.log(`  - ${relPath} (404 not in repo, skipped)`)
      return
    }
    throw new Error(`fetch ${relPath}: HTTP ${res.status}`)
  }
  // onnx 二进制走流式落盘；文本小文件也走流（统一路径，省分支）
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
  const st = await stat(dest)
  console.log(`  ✓ ${relPath} (${Math.round(st.size / 1024)}KB)`)
}

async function main() {
  console.log(`[fetch-kb-model] MODEL_ID=${MODEL_ID} OUT=${OUT_DIR} HOST=${HOST}`)
  await mkdir(join(OUT_DIR, MODEL_ID), { recursive: true })
  for (const f of FILES) {
    await fetchFile(f)
  }
  console.log(`[fetch-kb-model] done → ${join(OUT_DIR, MODEL_ID)}`)
}

main().catch((e) => {
  console.error('[fetch-kb-model] FAILED:', e.message)
  process.exit(1)
})
