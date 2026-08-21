// —— 向量化推理 worker（docs/VECTOR_KB_PLAN.md §二，铁律23 同类）——
//
// 由主进程用 child_process.spawn + ELECTRON_RUN_AS_NODE 拉起独立 node 子进程跑，
// 不在主线程同步 encode（embedding 是 CPU 密集，会阻塞事件循环、groupchat
// 多 agent 并发时冻死）。主进程绝不直接 import transformers（铁律1：能力收口主进程，
// 但推理在子进程）。
//
// === transformers.js v4 WASM-in-Node 配方（实测 darwin/x64 通过，详见
//     [[transformers-v4-wasm-node-recipe]]）===
// v4 的 Node 构建（transformers.node.cjs）强制走 onnxruntime-node 原生 binding，
// 而 onnxruntime-node npm 包不 ship darwin/x64 二进制 → Intel Mac 不可用。
// web 构建（transformers.web.js）把 node:fs/onnxruntime-node stub 成 {} →
// 直接 require() 在 ONNX session 创建处炸（ONNX = 空的 onnxruntime_node_exports）。
//
// 解法：
//  1. require('onnxruntime-web')（顶层 dep，main=dist/ort.node.min.js = WASM-in-Node）
//  2. globalThis[Symbol.for('onnxruntime')] = ort（require transformers 之前）
//     → transformers.web.js line 7655 读此 symbol 作 ONNX，绕过空 stub
//  3. require(transformers.web.js 绝对路径)（绕过 package.json exports 的 node 条件）
//  4. env.useCustomCache + customCache 喂模型文件（fs 被 stub，必须手动 match/put）
//     remoteHost=hf-mirror.com（v4 web 构建硬编码 huggingface.co，不读 HF_ENDPOINT env）
//  5. AutoTokenizer + 手动 ort.InferenceSession + 手动 mean-pool/L2 normalize
//     （不用 pipeline('feature-extraction')——其 device-dispatch 在 symbol-shortcut
//      分支 supportedDevices 为空报 "Unsupported device"）
//
// 协议：stdin 读 JSON 行 {id, texts, kind?}，stdout 写 JSON 行 {id, vectors|error}。
//   kind: 'query' | 'passage' —— e5 非对称检索前缀标记（KB_CODE_REVIEW P2 复核项）。
//          isE5 时 worker 按 kind 给每条文本加 "query: "/"passage: " 前缀；非 e5 忽略。
'use strict'

const fs = require('fs')
const path = require('path')

// —— env（spawn 时由主进程注入）——
const MODEL_DIR = process.env.MODEL_DIR || ''
const MODEL_ID = process.env.MODEL_ID || 'Xenova/multilingual-e5-small'
const MODULES_DIR = process.env.WORKER_MODULES_DIR || ''
const REMOTE_HOST = process.env.KB_REMOTE_HOST || 'https://hf-mirror.com/'

// e5 系非对称检索：query/passage 加不同前缀。其余模型（bge 等）不支持此约定，忽略。
const IS_E5 = /e5/i.test(MODEL_ID)
const E5_PREFIX = { query: 'query: ', passage: 'passage: ' }

function die(msg) {
  try {
    process.stdout.write(JSON.stringify({ id: '__init__', error: 'init_failed', message: msg }) + '\n')
  } catch (_) { /* ignore */ }
  process.exit(1)
}

// —— 1. onnxruntime-web (WASM backend) ——
let ort
let transformers
let tokenizer
let session
try {
  const ortPath = MODULES_DIR
    ? path.join(MODULES_DIR, 'onnxruntime-web')
    : 'onnxruntime-web'
  ort = require(ortPath)
  // WASM 运行时文件路径：require.resolve(onnxruntime-web) → dist/ort.node.min.js，
  // dirname 即 dist/；带尾斜杠（否则拼成 distort-wasm... 找不到模块）
  const wasmDir = path.dirname(require.resolve(ortPath)) + path.sep
  ort.env.wasm.wasmPaths = wasmDir
  ort.env.wasm.proxy = false
  // 2. 注入到全局符号，transformers.web.js 会读它作 ONNX
  globalThis[Symbol.for('onnxruntime')] = ort
} catch (e) {
  die('onnxruntime-web 加载失败: ' + (e.message || String(e)))
}

// —— 3. transformers.web.js（绝对路径，绕 exports）——
try {
  const tfPath = MODULES_DIR
    ? path.join(MODULES_DIR, '@huggingface/transformers/dist/transformers.web.js')
    : require.resolve('@huggingface/transformers/dist/transformers.web.js')
  transformers = require(tfPath)
} catch (e) {
  die('transformers.web.js 加载失败: ' + (e.message || String(e)))
}

// —— 4. env + customCache 喂模型 ——
const env = transformers.env
env.allowLocalModels = false
env.allowRemoteModels = true
env.remoteHost = REMOTE_HOST
env.useCustomCache = true

// 模型根目录：MODEL_DIR/<MODEL_ID>。fetch-kb-model.mjs 按 HF 仓结构下载到
// OUT_DIR/<MODEL_ID>/<file>，故 worker 磁盘读写都以 MODEL_ID 子目录为根。
const MODEL_ROOT = MODEL_DIR ? path.join(MODEL_DIR, MODEL_ID) : ''

// 把 cache key（完整 URL 或 /models/<model>/<file>）抽 <file> 映射到 MODEL_ROOT 磁盘
function relFromKey(key) {
  const probe = '/models/' + MODEL_ID + '/'
  const remote = REMOTE_HOST + MODEL_ID + '/resolve/main/'
  if (key.startsWith(probe)) return key.slice(probe.length)
  if (key.startsWith(remote)) return key.slice(remote.length)
  if (key.startsWith(MODEL_ID + '/')) return key.slice(MODEL_ID.length + 1)
  return null
}
env.customCache = {
  async match(name) {
    if (!MODEL_ROOT) return undefined
    const rel = relFromKey(name)
    if (rel === null) return undefined
    const p = path.join(MODEL_ROOT, rel)
    try {
      if (!fs.existsSync(p)) return undefined
      return new Response(new Uint8Array(fs.readFileSync(p)))
    } catch (_) {
      return undefined
    }
  },
  async put(name, resp) {
    if (!MODEL_ROOT) return
    const rel = relFromKey(name)
    if (rel === null) return
    const p = path.join(MODEL_ROOT, rel)
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      const buf = new Uint8Array(await resp.arrayBuffer())
      fs.writeFileSync(p, buf)
    } catch (_) {
      /* 非致命：缓存写失败不影响本次结果 */
    }
  },
}

// —— 5. tokenizer + session + 手动 pooling ——
// onnx 权重文件名：优先量化版（fetch-kb-model.mjs 下载的、体积小、WASM 友好），
// 降级非量化 model.onnx（旧版/某些模型仓只有全量版）。两处文件名须与
// fetch-kb-model.mjs / kb-spike.mjs 一致，否则「fetch 下载量化 → worker 找非量化」
// 链路断（KB_CODE_REVIEW P0-1 实证 bug）。
const ONNX_CANDIDATES = ['onnx/model_quantized.onnx', 'onnx/model.onnx']

async function init() {
  tokenizer = await transformers.AutoTokenizer.from_pretrained(MODEL_ID)
  let modelBuf
  // 本地优先：MODEL_ROOT 下按候选顺序找第一个存在的
  if (MODEL_ROOT) {
    for (const rel of ONNX_CANDIDATES) {
      const p = path.join(MODEL_ROOT, rel)
      if (fs.existsSync(p)) {
        modelBuf = fs.readFileSync(p)
        break
      }
    }
  }
  // 本地没有 → 走 remote 经 customCache（match 命中本地缓存 / 否则 remote 下载 → put 落盘 → 再读）
  if (!modelBuf) {
    for (const rel of ONNX_CANDIDATES) {
      const fileResp = await env.customCache.match(
        REMOTE_HOST + MODEL_ID + '/resolve/main/' + rel,
      )
      if (fileResp) {
        modelBuf = Buffer.from(await fileResp.arrayBuffer())
        break
      }
    }
    if (!modelBuf) {
      throw new Error(
        'onnx 权重不可得（本地无 + 远程下载失败，候选: ' + ONNX_CANDIDATES.join(', ') + '）',
      )
    }
  }
  session = await ort.InferenceSession.create(modelBuf, {
    graphOptimizationLevel: 'all',
  })
}

async function embed(texts, kind) {
  // e5 非对称前缀：ingestion(passage) / search(query) 不同前缀，漏加会静默掉召回。
  // 集中在此处理，调用方只传 kind，不再手写字符串拼接（消除 silent landmine）。
  let inputTexts = texts
  if (IS_E5 && kind && E5_PREFIX[kind]) {
    inputTexts = texts.map((t) => E5_PREFIX[kind] + t)
  }
  const encoded = await tokenizer(inputTexts, { padding: true, truncation: true })
  const inputIds = encoded.input_ids
  const attentionMask = encoded.attention_mask
  // 按 session.inputNames 喂图所需的全部输入（而非写死 input_ids/attention_mask）。
  // e5/bge 系图可能要 token_type_ids，而 tokenizer 不一定产出 → 零填充到正确 shape。
  // 批量 padding：input_ids dims = [B, L]；缺失输入须按 [B, L] 零填，单批一条是 [1, L]。
  const batch = inputIds.dims[0]
  const inputLen = inputIds.dims[1] // padding 后序列长度
  const feed = {}
  for (const k of session.inputNames) {
    if (encoded[k]) {
      feed[k] = new ort.Tensor('int64', Array.from(encoded[k].data), encoded[k].dims)
    } else {
      // 图需要但 tokenizer 没出（如 e5 的 token_type_ids）→ 零填充 [batch, inputLen]
      feed[k] = new ort.Tensor(
        'int64',
        new BigInt64Array(batch * inputLen).fill(0n),
        [batch, inputLen],
      )
    }
  }
  const out = await session.run(feed)
  const last = out.last_hidden_state || out[session.outputNames[0]]
  const dims = last.dims // [B, L, D]；BERT 系 L === inputLen
  const B = dims[0], L = dims[1], D = dims[2]
  const data = last.data
  // attention_mask.data 是 BigInt64Array（int64 tensor）→ Array.from 得 BigInt；
  // Number() 归一后比较，兼容 0n / 0 两种元素类型（kb-spike.mjs 用 === 0n，等价语义）。
  const mask = Array.from(attentionMask.data).map(Number)
  const vecs = []
  for (let b = 0; b < B; b++) {
    const acc = new Float32Array(D)
    let cnt = 0
    for (let l = 0; l < L; l++) {
      if (mask[b * L + l] === 0) continue
      cnt++
      for (let d = 0; d < D; d++) acc[d] += data[(b * L + l) * D + d]
    }
    if (cnt > 0) for (let d = 0; d < D; d++) acc[d] /= cnt
    // L2 归一化
    let nrm = 0
    for (let d = 0; d < D; d++) nrm += acc[d] * acc[d]
    nrm = Math.sqrt(nrm) || 1
    for (let d = 0; d < D; d++) acc[d] /= nrm
    vecs.push(Array.from(acc)) // JSON 可序列化
  }
  return vecs
}

// —— stdio 协议：逐行读 {id, texts}，逐行写 {id, vectors|error} ——
// 生命周期：主进程懒 spawn 一次、跨 batch 复用。stdin EOF 时主进程要终止 worker，
// 但必须等进行中的 batch 完成 + 响应写出后才退（否则丢响应）。
let initialized = false
// init-promise 去重（review #6）：init() 加载 ~23MB 模型需 1-2s，期间并发到达的
// batch 若各自进 init() 会重复加载致内存翻倍。共享同一 promise，所有并发 batch 等同一次加载。
let initPromise = null
let pending = 0
let stdinEnded = false
let buf = ''

async function handleRequest(req) {
  const id = req.id
  pending++
  try {
    if (!initialized) {
      if (!initPromise) initPromise = init()
      await initPromise
      initialized = true
    }
    const texts = Array.isArray(req.texts) ? req.texts : [String(req.texts ?? '')]
    const vecs = await embed(texts, req.kind)
    const out = vecs.map((v) => (v.every((x) => x === 0) ? null : v))
    process.stdout.write(JSON.stringify({ id, vectors: out }) + '\n')
  } catch (e) {
    process.stdout.write(
      JSON.stringify({ id, error: 'embed_failed', message: e.message || String(e) }) + '\n',
    )
    // init 失败 → 退出让主进程 respawn
    if (!initialized) die('init failed: ' + (e.message || String(e)))
  } finally {
    pending--
    maybeExit()
  }
}

function maybeExit() {
  if (stdinEnded && pending <= 0) process.exit(0)
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let req
    try {
      req = JSON.parse(line)
    } catch (e) {
      process.stdout.write(JSON.stringify({ id: null, error: 'bad_json', message: e.message }) + '\n')
      continue
    }
    // 不 await：并发处理多 batch（逐行投递），各自完成后 maybeExit
    handleRequest(req)
  }
})
process.stdin.on('end', () => {
  stdinEnded = true
  maybeExit()
})
process.on('uncaughtException', (e) => {
  process.stdout.write(
    JSON.stringify({ id: null, error: 'uncaught', message: e.message || String(e) }) + '\n',
  )
})
