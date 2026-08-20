// —— KB 中文质量 spike 骨架（docs/VECTOR_KB_PLAN.md §二:71）——
//
// 目的：用向量语义检索重跑 docs/SKILL_RAG_EVAL.md 的 22 条 query，对比当前 FTS 词法
// 召回（Primary Top3 仅 86.4%），判断向量路是否值得接（P1 决策依据）。
//
// 跑法：用与 worker-embed.cjs 同配方（[[transformers-v4-wasm-node-recipe]]）——
// 纯 WASM、零 native、零 electron-rebuild、darwin/x64 可跑。spike 进程内直接 embed
// （不 spawn worker 子进程——spike 是一次性脚本，不需要持久 worker 复用）。
//
// 用法：
//   npm run kb:spike                              # 默认 multilingual-e5-small，从 hf-mirror 下模型
//   npm run kb:spike -- --model-dir /path/to/model  # 用指定模型目录
//   npm run kb:spike -- --skills-dir /path/to/skills # 用指定 skills 目录
//   npm run kb:spike -- --model-id Xenova/bge-m3    # 换模型评测
//
// P0 交付：可跑骨架 + 对比表。P1 出真实结果 + 质量判定（是否超 86.4%）。

import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, normalize, dirname } from 'node:path'
import { homedir, platform } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// —— 参数 ——（默认与 worker-client DEFAULT_MODEL_ID 一致：中文 e5-small）
const MODEL_ID = argValue('--model-id', 'Xenova/multilingual-e5-small')
const MODEL_DIR = normalize(argValue('--model-dir', defaultModelDir()))
const SKILLS_DIR = argValue('--skills-dir', defaultSkillsDir())
const REMOTE_HOST = 'https://hf-mirror.com/'

function argValue(flag, def) {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}

/** 找项目根（含 package.json 的目录，含 node_modules）。spike 在 scripts/ 下，向上找。 */
function findProjectRoot() {
  // createRequire(import.meta.url) 的 resolve 路径含项目根；或 __dirname 向上找 package.json
  let dir = dirname(new URL('.', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:\/)/, ''))
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'node_modules'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

function defaultModelDir() {
  const prod = process.env.ONE_USER_DATA
  if (prod && existsSync(prod)) return join(prod, 'kb-models')
  // dev fallback：~/Library/Application Support/one/kb-models (mac) / ~/.config/one/kb-models
  const base =
    platform() === 'darwin'
      ? join(homedir(), 'Library/Application Support/one')
      : join(homedir(), '.config/one')
  return join(base, 'kb-models')
}

function defaultSkillsDir() {
  const prod = process.env.ONE_USER_DATA
  if (prod && existsSync(prod)) return join(prod, 'skills')
  const base =
    platform() === 'darwin'
      ? join(homedir(), 'Library/Application Support/one/config')
      : join(homedir(), '.config/one/config')
  return join(base, 'skills')
}

// —— 22 条评测 query（抄自 docs/SKILL_RAG_EVAL.md §明细）——
const QUERIES = [
  { q: '帮我做技术公众号内容生产闭环', primary: 'wechat-tech-content', ok: ['wechat-tech-content'] },
  { q: '帮我做全网技术选题调研，给 3 个高价值方向', primary: 'tech-research', ok: ['tech-research'] },
  { q: '拆解 3 个同类技术号的标题公式和结构套路', primary: 'content-teardown', ok: ['content-teardown'] },
  { q: '按技术号风格模板写一篇微信公众号深度文', primary: 'wechat-writing', ok: ['wechat-writing', 'wechat-tech-content'] },
  { q: '对这篇文章做审稿打分，不通过就返工', primary: 'content-review', ok: ['content-review'] },
  { q: '把 Markdown 转成公众号 HTML', primary: 'md2wechat', ok: ['md2wechat', 'baoyu-post-to-wechat'] },
  { q: '把这篇文章发布到微信公众号草稿箱', primary: 'baoyu-post-to-wechat', ok: ['baoyu-post-to-wechat'] },
  { q: '帮我做一个高端品牌手册和视觉规范板', primary: 'brandkit', ok: ['brandkit'] },
  { q: '重做现有网站，让质感更高级但不破坏功能', primary: 'redesign-existing-projects', ok: ['redesign-existing-projects'] },
  { q: '把这个前端界面打磨得更有设计感', primary: 'impeccable', ok: ['impeccable'] },
  { q: '帮我创建飞书文档并插入图片', primary: 'lark-doc', ok: ['lark-doc'] },
  { q: '查一下同事的 open_id 和联系方式', primary: 'lark-contact', ok: ['lark-contact'] },
  { q: '生成一份今天的日程和待办摘要', primary: 'lark-workflow-standup-report', ok: ['lark-workflow-standup-report'] },
  { q: '帮我在飞书日历里创建一个明天下午的会议', primary: 'lark-calendar', ok: ['lark-calendar'] },
  { q: '创建一个飞书电子表格并写入表头和数据', primary: 'lark-sheets', ok: ['lark-sheets'] },
  { q: '整理本周会议纪要并生成结构化周报', primary: 'lark-workflow-meeting-summary', ok: ['lark-workflow-meeting-summary'] },
  { q: '帮我做一个 X 账号内容作战计划 PDF', primary: 'dashen-x-battle-plan', ok: ['dashen-x-battle-plan'] },
  { q: '做一个 Vue 3 脚手架项目', primary: 'vue-init', ok: ['vue-init'] },
  { q: '帮我测试本地 web 应用页面交互', primary: 'webapp-testing', ok: ['webapp-testing', 'webapp-quality-gate'] },
  { q: '帮我建立一个 GitHub 仓库知识库并支持搜索', primary: 'github-kb', ok: ['github-kb'] },
  { q: '帮我创建一个新的 agent skill', primary: 'skill-creator', ok: ['skill-creator'] },
  { q: '帮我找一个能完成这个任务的 skill', primary: 'find-skills', ok: ['find-skills'] },
]

// —— 收集 skills 语料（镜像 collectSkillsIndexData，但独立读盘不拉 DB）——
function collectSkillCorpus() {
  if (!existsSync(SKILLS_DIR)) {
    console.error(`[kb-spike] skills 目录不存在: ${SKILLS_DIR}`)
    console.error(`  用 --skills-dir 指定，或设置 ONE_USER_DATA`)
    process.exit(1)
  }
  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('skl_upload_'))
    .sort((a, b) => a.name.localeCompare(b.name))
  const corpus = []
  for (const entry of entries) {
    const skillMd = join(SKILLS_DIR, entry.name, 'SKILL.md')
    if (!existsSync(skillMd)) continue
    try {
      const text = readFileSync(skillMd, 'utf8')
      // 取 name + description（YAML frontmatter）+ 正文前 2000 字作语料
      const nameMatch = text.match(/^name:\s*(.+)$/m)
      const descMatch = text.match(/^description:\s*(.+)$/m)
      const name = nameMatch ? nameMatch[1].trim() : entry.name
      const desc = descMatch ? descMatch[1].trim() : ''
      const body = text.replace(/^---[\s\S]*?---/, '').slice(0, 2000)
      corpus.push({ id: entry.name, text: `${name} ${desc} ${body}`.trim() })
    } catch {
      // 跳过读不了的
    }
  }
  return corpus
}

// —— transformers.js v4 WASM-in-Node 配方（[[transformers-v4-wasm-node-recipe]]）——
// 与 worker-embed.cjs 同配方，spike 进程内直接跑（不 spawn 子进程）。
async function loadEmbedder() {
  // 解析模块根：dev=项目根 node_modules。用绝对路径 require 而非 require.resolve ——
  // transformers.web.js 被 package.json exports 屏蔽（ERR_PACKAGE_PATH_NOT_EXPORTED），
  // 必须绕 exports 用文件系统绝对路径（[[transformers-v4-wasm-node-recipe]] 第 3 步）。
  const projectRoot = findProjectRoot()
  const ortPath = join(projectRoot, 'node_modules/onnxruntime-web')
  const tfPath = join(
    projectRoot,
    'node_modules/@huggingface/transformers/dist/transformers.web.js',
  )

  // 1. onnxruntime-web (WASM)，设 wasmPaths（尾斜杠）+ proxy=false
  const ort = require(ortPath)
  ort.env.wasm.wasmPaths = dirname(require.resolve(ortPath)) + '/'
  ort.env.wasm.proxy = false
  // 2. 注入 globalThis symbol（transformers.web.js line 7655 读此作 ONNX）
  globalThis[Symbol.for('onnxruntime')] = ort
  // 3. transformers web 构建（绝对路径 require，绕 exports node 条件）
  const transformers = require(tfPath)
  const { env, AutoTokenizer } = transformers

  // 4. env：禁本地模型、允许远程、走 hf-mirror、customCache 喂模型到 MODEL_DIR
  env.allowLocalModels = false
  env.allowRemoteModels = true
  env.remoteHost = REMOTE_HOST
  env.useCustomCache = true
  mkdirSync(MODEL_DIR, { recursive: true })
  env.customCache = {
    match(name) {
      const file = relFromKey(name)
      const p = join(MODEL_DIR, MODEL_ID, file)
      if (!existsSync(p)) return Promise.resolve(undefined)
      const buf = readFileSync(p)
      // 构造完整 fake Response：headers.get / text / json / arrayBuffer
      // transformers 的 _get_file_metadata 会读 headers.get('content-length') 决定加载方式
      return Promise.resolve({
        ok: true,
        url: p,
        status: 200,
        headers: {
          get(k) {
            if (k.toLowerCase() === 'content-length') return String(buf.length)
            return null
          },
        },
        text: () => Promise.resolve(buf.toString('utf8')),
        json: () => Promise.resolve(JSON.parse(buf.toString('utf8'))),
        arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
      })
    },
    put(name, resp) {
      const file = relFromKey(name)
      const p = join(MODEL_DIR, MODEL_ID, file)
      mkdirSync(dirname(p), { recursive: true })
      return resp.arrayBuffer().then((ab) => {
        writeFileSync(p, Buffer.from(ab))
      })
    },
  }

  // 5. AutoTokenizer（不用 pipeline——device-dispatch 在 symbol-shortcut 分支 supportedDevices 空）
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID)
  // 6. onnx 权重：从 MODEL_DIR 读或经 customCache 下
  const onnxRel = 'onnx/model_quantized.onnx'
  const onnxPath = join(MODEL_DIR, MODEL_ID, onnxRel)
  let modelBuf
  if (existsSync(onnxPath)) {
    modelBuf = readFileSync(onnxPath)
  } else {
    // customCache.put 会落盘；这里触发 fetch → put → 再 match
    const cached = await env.customCache.match(`${REMOTE_HOST}${MODEL_ID}/resolve/main/${onnxRel}`)
    if (cached) modelBuf = readFileSync(onnxPath)
  }
  if (!modelBuf) throw new Error(`onnx 权重缺失：${onnxPath}（先跑 scripts/fetch-kb-model.mjs）`)
  const session = await ort.InferenceSession.create(modelBuf, { graphOptimizationLevel: 'all' })

  return { ort, tokenizer, session }
}

function relFromKey(key) {
  // key 形如 https://hf-mirror.com/<MODEL_ID>/resolve/main/<file> 或 /models/<MODEL_ID>/<file>
  const m = key.match(/\/(?:models\/)?[^/]+\/(?:resolve\/main\/)?(.+)$/)
  if (m) return m[1]
  return key.split('/').pop() || key
}

// —— embed：tokenizer + 手动 session + mean-pool + L2 norm ——
async function embed(embedder, texts) {
  const { ort, tokenizer, session } = embedder
  const inputNames = session.inputNames
  const out = []
  for (const text of texts) {
    const enc = await tokenizer(text, { padding: true, truncation: true, max_length: 512 })
    const feeds = {}
    const L = enc.input_ids.dims[1]
    for (const k of inputNames) {
      if (enc[k]) {
        feeds[k] = new ort.Tensor('int64', Array.from(enc[k].data), enc[k].dims)
      } else {
        // 图需要但 tokenizer 没出（如 token_type_ids）→ 零填充到正确 shape
        feeds[k] = new ort.Tensor('int64', new BigInt64Array(L).fill(0n), [1, L])
      }
    }
    const res = await session.run(feeds)
    const lhs = res.last_hidden_state
    // lhs dims [B=1, L, D]
    const data = lhs.data
    const dims = lhs.dims
    const Lc = dims[1]
    const D = dims[2]
    const mask = enc.attention_mask ? enc.attention_mask.data : new BigInt64Array(Lc).fill(1n)
    // mean-pool by attention_mask + L2 normalize
    const pooled = new Float32Array(D)
    let count = 0
    for (let l = 0; l < Lc; l++) {
      if (mask[l] === 0n) continue
      count++
      for (let d = 0; d < D; d++) pooled[d] += data[l * D + d]
    }
    if (count > 0) for (let d = 0; d < D; d++) pooled[d] /= count
    let norm = 0
    for (let d = 0; d < D; d++) norm += pooled[d] * pooled[d]
    norm = Math.sqrt(norm) || 1
    for (let d = 0; d < D; d++) pooled[d] /= norm
    out.push(pooled)
  }
  return out
}

function cosine(a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot // 已归一化
}

async function main() {
  console.log(`[kb-spike] MODEL_ID=${MODEL_ID} MODEL_DIR=${MODEL_DIR} SKILLS_DIR=${SKILLS_DIR}`)
  if (!existsSync(MODEL_DIR)) {
    console.log(`[kb-spike] 模型目录不存在，将从 ${REMOTE_HOST} 下载到 ${MODEL_DIR}`)
  }
  console.log('[kb-spike] 加载 embedder（WASM）...')
  const embedder = await loadEmbedder()
  console.log('[kb-spike] 收集 skill 语料...')
  const corpus = collectSkillCorpus()
  if (corpus.length === 0) {
    console.error('[kb-spike] 无 skill 语料，退出。检查 --skills-dir')
    process.exit(1)
  }
  console.log(`[kb-spike] 语料 ${corpus.length} 条，开始 embed...`)
  // e5 系是非对称检索：query 加 "query: "、corpus 加 "passage: " 前缀
  const isE5 = /e5/i.test(MODEL_ID)
  const qPrefix = isE5 ? 'query: ' : ''
  const pPrefix = isE5 ? 'passage: ' : ''
  if (isE5) console.log('[kb-spike] 检测到 e5 模型，启用 query:/passage: 非对称前缀')
  const corpusVecs = await embed(
    embedder,
    corpus.map((c) => pPrefix + c.text),
  )

  // 跑 22 query
  console.log('[kb-spike] 跑 22 query...')
  // ID 归一化：skill 目录名可能带 skl_import_ / skl_upload_ 前缀，评测期望是裸 id。
  // 比较时剥前缀，避免「语义对了但 ID 前缀不一致」误判为 0%。
  const normId = (id) => id.replace(/^skl_(?:import|upload)_/, '')
  const results = []
  let primaryTop1 = 0
  let relaxedTop3 = 0
  for (const item of QUERIES) {
    const [qv] = await embed(embedder, [qPrefix + item.q])
    const scored = corpusVecs
      .map((v, i) => ({ id: corpus[i].id, norm: normId(corpus[i].id), score: cosine(qv, v) }))
      .sort((a, b) => b.score - a.score)
    const top3 = scored.slice(0, 3)
    const top1Id = top3[0]?.id
    const top3Ids = top3.map((t) => t.id)
    const p1 = top3[0]?.norm === item.primary
    const r3 = top3.some((t) => item.ok.includes(t.norm))
    if (p1) primaryTop1++
    if (r3) relaxedTop3++
    results.push({ ...item, top1Id, top3Ids, p1, r3 })
  }

  // 输出对比表
  console.log('\n====== KB 中文质量 spike 结果 ======')
  console.log('模型:', MODEL_ID)
  console.log('语料:', corpus.length, '条 skill')
  console.log('')
  console.log('| query | 期望主目标 | Top1 | Top3 | Primary Top1 | Relaxed Top3 |')
  console.log('|---|---|---|---|---|---|')
  for (const r of results) {
    console.log(
      `| ${r.q} | ${r.primary} | ${r.top1Id} | ${r.top3Ids.join(' / ')} | ${r.p1 ? '✅' : '❌'} | ${r.r3 ? '✅' : '❌'} |`,
    )
  }
  console.log('')
  console.log(`Primary Top1: ${primaryTop1}/22 (${Math.round((primaryTop1 / 22) * 1000) / 10}%)`)
  console.log(`Relaxed Top3: ${relaxedTop3}/22 (${Math.round((relaxedTop3 / 22) * 1000) / 10}%)`)
  console.log('（对比 docs/SKILL_RAG_EVAL.md FTS 词法：Primary Top1 77.3% / Relaxed Top3 90.9%）')
}

main().catch((e) => {
  console.error('[kb-spike] FAILED:', e)
  process.exit(1)
})
