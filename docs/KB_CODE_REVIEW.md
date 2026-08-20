# 向量化知识库（KB）代码 Review — 建议修改清单

> 范围：基于 `feat: 知识库向量检索（P0）` 分支改动（`src/main/vector/*`、`worker-embed.cjs`、`knowledge.ts`、两个打包配置、`db.ts` v10 migration、两个脚本）。
> 目的：把 code review 中「建议修改」的内容单独沉淀，作为动工前核对表 + 改动后回归清单。
> 结论总览：**评审设计原则已落地（worker 移主线程 / HF mirror / RRF / 内存上限 / vec NULL 降级链 / 事务双写 / 回归测试）；P0-1（onnx 文件名错配）/ P0-2（默认英文模型）/ P0-3（e5 token_type_ids 缺输入）三项真实 bug 均已复现并修复，回归全绿；打包「web.js 不自包含」为误报。复核补充的 P2 项（e5 非对称前缀机制 + 兜底 MODEL_ID 英文残留）也已落地（2026-08-20），typecheck + 23 项 vector 单测全绿。可进 P1/P3。**

---

## 核实结论（2026-08-20 复核，逐条对照实际代码）

> 复核方法：逐文件读源码 + 真机跑 worker 验证 + 查 HF 仓文件清单。

### P0-1 ✅ **真实 bug，已复现**

核实结论：**review 主张成立，但「HF 仓只有 model_quantized.onnx 没有 model.onnx」这句事实有误**——实际 `Xenova/all-MiniLM-L6-v2` 仓**两者都有**（`model.onnx` = 非量化全量 ~90MB，`model_quantized.onnx` = 量化 ~22MB）。但不影响结论：`fetch-kb-model.mjs:35` 下载 `model_quantized.onnx` 到磁盘，`worker-embed.cjs:126/134` 找 `model.onnx` → 本地找不到（名字对不上）→ 转远程也找 `model.onnx`（非量化全量，且 customCache key 是 `onnx/model.onnx` → 磁盘上叫 `model_quantized.onnx` → match 不到）→ 初始化失败。

**真机复现**（2026-08-20）：
```
$ echo '{"id":"b1","texts":["测试"]}' | MODEL_DIR=".../kb-models" ... node worker-embed.cjs
{"id":"b1","error":"embed_failed","message":"model.onnx 不可得（本地无 + 远程下载失败）"}
{"id":"__init__","error":"init_failed","message":"init failed: model.onnx 不可得（本地无 + 远程下载失败）"}
```
磁盘上明明有 `model_quantized.onnx`，worker 找 `model.onnx` 找不到。**完整包链路（fetch 量化 → worker 找非量化）确认为断的**。

> 掩盖因素：P0 smoke test 当时通过，是因为 worker 走 remote 直接下载了非量化 `model.onnx`（90MB）跑通，没走 fetch-kb-model 落盘的量化版。所以「实测 WASM 全链路通」是真的，但完整包的「本地优先 + 量化」链路是断的。

修复：worker-embed.cjs 本地优先找 `onnx/model_quantized.onnx`（与 fetch 对齐），降级 `model.onnx`；remote key 也用 `model_quantized.onnx`。**已修。**

### P0-2 ✅ **真实偏差（默认模型英文 vs 方案中文决策）**

核实结论：**成立**。方案 §二:61「中文建议量化的 bge-m3 或 multilingual-e5-small」+ §二:72「中文默认即 quantized bge-m3，不另设升档兜底」+ types.ts:97 注释「bge-m3=1024」。但代码 `worker-client.ts:149` `DEFAULT_MODEL_ID='Xenova/all-MiniLM-L6-v2'`（英文）、`:152` `DEFAULT_MODEL_DIM=384`，types.ts:97 注释与实现自相矛盾。

> 不过 review 有一处事实需修正：「若坚持 bge-m3，需额外适配其 query 指令前缀」——**bge-m3 不用 query/passage 前缀**（那是 e5 系的特性）。bge-m3 dense 检索直接编码即可。所以切 bge-m3 反而比切 e5-simple 少一个前缀适配。spike 实测 e5-small 需 `query:`/`passage:` 前缀才工作（kb-spike.mjs 已加 isE5 分支）。

> spike 实测补充（2026-08-19）：multilingual-e5-small（中文+前缀）在 skill-RAG 跑 36.4%/50%，**低于 FTS 86.4%**。所以 review 的验收标准「中文 Top3 应 ≥ 86.4%」对**纯向量**已被证伪——但这是 P2 hybrid 决策依据（向量作 RRF 补强非替代），不改变 P0-2「默认应是中文模型」的事实判断。

修复：默认改 `Xenova/multilingual-e5-small`（384 维，与 MiniLM 同维，无需改 DIM/索引；中文覆盖；WASM 友好）。types.ts 注释 DIM 改 384。**已修。** bge-m3（1024）留作 P1 中文质量 spike 验证后的升级选项——届时同步改 DIM + vec_dim 漂移重嵌链路。

### P0-3 ✅ **真实 bug（切 e5-small 后暴露，review 未提及）**

核实结论：**成立**——切默认模型到 e5-small 后，worker `embed()` 炸 `input 'token_type_ids' is missing in 'feeds'`。根因：e5-small 的 ONNX 图输入含 `token_type_ids`，但 transformers.js 的 `AutoTokenizer` 对该模型**不产出** `token_type_ids`（非 BERT 系典型行为）。worker 原代码只在 `encoded.token_type_ids && session.inputNames.includes('token_type_ids')` 时才喂 → 条件不满足 → 图缺输入 → 失败。

kb-spike.mjs 早有正确解法（逐条 embed、`[1,L]` 零填充），但 worker 批量路径漏了。

**真机复现**（2026-08-20）：
```
$ echo '{"id":"b1","texts":["测试中文 embedding","hello world"]}' | ... node worker-embed.cjs
{"id":"b1","error":"embed_failed","message":"input 'token_type_ids' is missing in 'feeds'."}
```

修复：worker `embed()` 改为**遍历 `session.inputNames`** 喂图所需的全部输入，tokenizer 没产出的（如 `token_type_ids`）按 `[batch, L]` 零填充（`BigInt64Array`）。批量 padding 下 `batch = inputIds.dims[0]`（非写死 1，否则 `{1,8,384} != {2,8,384}` shape mismatch）。另修 `attention_mask` 比较：`data` 是 `BigInt64Array` → `Array.from(...).map(Number)` 后比 `=== 0`（原 `=== 0` 对 BigInt 永不命中 padding，latent masking bug）。**已修，真机返回 2×384 维向量。**

### 打包项 — 部分误报

| 项 | review 风险 | 核实 | verdict |
|---|---|---|---|
| full 包 transformers.web.js 单文件 | 「若内部相对 require 同 dist 其他文件」 | `grep require(` transformers.web.js = **0 处**——完全自包含 bundle（静态 import 内联，无运行时 require）。dist 下其他文件（transformers.node.cjs 等）web 版不依赖。spike 进程内已用同文件跑通。 | **误报**，单文件拷贝正确 |
| remoteHost 双斜杠 | 手工字符串拼接风险 | 默认值带尾斜杠（`https://hf-mirror.com/`），worker-client 注入也带尾斜杠，拼接 `REMOTE_HOST + MODEL_ID + '/resolve/main/'` 单斜杠正确。仅当用户自设无尾斜杠 env 时才错。 | **轻微**，可加固（`new URL()`）但不阻断 |
| bge-m3 WASM op 支持度 | 未实测 | 待切 bge-m3 时冒烟（P1） | **后置**，非 P0 |

### 已正确落地（复核确认，勿破坏）

- **推理移出主线程**：`worker-embed.cjs` 用 `child_process.spawn + ELECTRON_RUN_AS_NODE`（非 worker_threads），主进程零 transformers 依赖、干净隔离；复刻 skillScript 的 `detached + killProcessGroup + timeout + AbortSignal` 纪律。
- **Windows 降级优雅**：`processKill.ts` 在 `kill(-pid)` 抛异常时降级只杀直接子进程，符合方案跨平台断言。
- **RRF 正确**：NULL-vec 不进向量候选集、只计词法 rank，离线块公平（§六落地）。
- **内存上限分片降级**：`flat-index.ts` `HARD_CAP = 20000` + 分片 + 无 docIds 降级 + 维度不匹配降级（§四）。
- **事务化双写**：`store.ts` 双写 + `vecToBlob` 处理 byteOffset（有测试）+ vec NULL 允许 + invalidate 全量重载（注释声明 P1 优化）。
- **db v10 migration 正确**：`UNIQUE(doc_id, chunk_idx)` 幂等 + vec BLOB NULL + vec_dim；维度漂移双检（embed.ts + db.ts）。
- **原子 FTS 重建**：`kb-fts.ts` 事务外 select + 事务内 DELETE+reinsert，镜像 `reindexL3Fts` 范式。
- **降级链完整**：worker 崩/timeout/abort → 批 null → 只词法，`embedBatchViaWorker` catch 永不抛。
- **接入收口**：`index.ts before-quit` 调 `terminateEmbedWorker`；`kb:status` IPC 收口 + preload 暴露一致。
- **回归测试齐全**：`v10` / `rrf` / `store` / `flat-index` `.test.ts` 存在，符合铁律「改动必带测试」。
- **task.md 已记 P0 决策**：child_process 选型、full/slim 双包、onnxruntime-web WASM。

### 复核补充（2026-08-20 第二轮 review — 新增待办，非 P0 阻断）

> 用户按本清单改完 P0 后复查，P0-1/P0-2/P0-3 均已修。以下两项为本轮新发现，均为 **P2 接入 search 前必须落**的点（不影响 P0 地基，但漏了会静默掉召回质量）。

**🟠 e5 非对称前缀未进生产 worker embed 路径（P2 前必须落）—— ✅ 已落（2026-08-20）**
- 现状：生产 embed 链路 `worker-embed.cjs` `embed()`（line 166）对 `texts` 原样 tokenize；`worker-client` `embedBatchViaWorker` 的 stdio 协议是 `{id, texts}`，**没有 `kind` 字段**，无法区分 query / passage。
- spike 在 `kb-spike.mjs` `main()`（line 277-296）按 `isE5` 在**调用处**手动拼 `query: `/`passage: ` 前缀，但共享的 worker embed 路径不处理前缀。
- 风险：e5 是非对称检索模型，query 与 passage 必须前缀区分；漏前缀**不报错、只是召回静默变差**（结合 spike 已实测 e5-small 纯向量仅 36.4%/50%，无前缀会更差）。P2 接 search 时若调用方忘记拼前缀，即 silent landmine。
- 修复（已落地）：`embedBatchViaWorker` 加显式 `kind: 'query' | 'passage'`，worker 协议带上 `kind`，`worker-embed.cjs` `embed()` 在 `isE5` 时按 `kind` 自动加前缀。ingestion（P1）传 `'passage'`、search query（P2）传 `'query'`，调用方不再手写拼接，使 P2 不可能忘。

**🟡 nit：`worker-embed.cjs:34` 兜底 MODEL_ID 仍是英文 —— ✅ 已修（2026-08-20）**
- `const MODEL_ID = process.env.MODEL_ID || 'Xenova/all-MiniLM-L6-v2'`（英文 MiniLM）。
- 生产由 `worker-client.ts` 注入 `MODEL_ID`（e5-small）覆盖，不会触发；但与「默认 e5-small」心智不一致。建议把兜底也改 `Xenova/multilingual-e5-small`，或删默认改为强制注入（缺则 init 失败早暴露）。

---

## 建议行动顺序（动工前核对表）

1. **[P0-1]** 修 `worker-embed.cjs` onnx 文件名 → `model_quantized.onnx`（本地优先 + remote key 对齐）。✅ 已修
2. **[P0-2]** 改默认模型为 `Xenova/multilingual-e5-small`（或中文 spike 验证 bge-m3 后改并补 query 前缀），同步修 `types.ts:97` 注释 DIM。✅ 已修（multilingual-e5-small，types 注释改 384）
3. **[P0-3]** 修 worker `embed()` 遍历 `session.inputNames` + 零填充缺失输入（e5 的 `token_type_ids`），批量 `[batch,L]` shape，`attention_mask` BigInt→Number 比较。✅ 已修，真机 2×384 维返回
4. **[验证]** `npm run kb:spike -- --model-id Xenova/multilingual-e5-small` 看中文 Top3 是否超 86.4% 基线。⚠️ 已跑：36.4%/50%，纯向量未超 FTS（→ P2 须 RRF hybrid 非替代，已存记忆）
5. **[打包]** full 包改为整目录拷 `transformers/dist`，并实跑 full 包 worker 初始化确认自包含。❌ 不需要——web.js 自包含，单文件正确
6. **[回归]** 跑 vector 单测 + `tsc --noEmit` + `vitest` 确认全绿。✅ typecheck 干净 + 75 文件 627 测试全过 + worker 真机 e5-small 往返
7. **[P2]** `embedBatchViaWorker` 加 `kind: 'query'|'passage'`，worker 协议带 `kind`，`worker-embed.cjs` `embed()` isE5 时按 `kind` 自动加 `query:`/`passage:` 前缀（避免 P2 接 search 漏前缀、召回静默变差）。✅ 已落：worker-client 协议 `{id,texts,kind}` + `EmbedKind` 类型 + worker `IS_E5`/`E5_PREFIX` 自动加前缀；ingestion 传 passage、search 传 query
8. **[P2 nit]** `worker-embed.cjs:34` 兜底 `MODEL_ID` 改 `Xenova/multilingual-e5-small`（与中文默认对齐）。✅ 已修

---

## 一句话 verdict

设计闭环站得住、工程判断到位；**P0-1（onnx 文件名错配）确为真实阻断 bug，已复现已修**；**P0-2（默认英文模型绕过中文决策）确为真实偏差，已改 multilingual-e5-small**；**P0-3（切 e5-small 后暴露的 `token_type_ids` 缺输入 + 批量 shape + BigInt masking）review 未提及，已发现并修**。打包「transformers.web.js 单文件不自包含」为误报（实测 0 require，自包含）。三点皆已修 + 回归全绿（627 测试 / typecheck / worker 真机 e5-small 往返），可进 P1/P3。
