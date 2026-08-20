# One — 向量化知识库改造方案（Vector KB / Semantic RAG）

> **目标**：给 One 增加真正的**向量语义检索**，覆盖两层诉求：
> 1. **新增「文档知识库」实体**——用户导入文档（md/pdf/txt 等），分块向量化，Agent 按需检索回答（文档 RAG）。
> 2. **升级现有检索为语义化**——把当前纯词法（FTS5 keyword）的 L3 记忆检索、skill 检索升级为**向量混合检索（hybrid）**，解决同义词/语义同义召回差的问题。
>
> **状态**：方案评审稿，待确认后动工（改后同步进 `task.md`）。
>
> **现状事实（2026-08 代码核验）**：
> - `node_modules` 无任何向量库；embedding/向量基础设施为 **0**。
> - 现有「RAG」全是词法：`searchL3`（FTS5+LIKE+key）、`searchSkills`（FTS5+name+LIKE）。`docs/SKILL_RAG_EVAL.md` 评测 Primary Top3 仅 **86.4%**（19/22），5 个错例经拆解实为 **2 排序错（目标已在 Top3）+ 1 近义混淆（webapp-testing/quality-gate，Relaxed 已通过）+ 2 词汇/意图匹配失败（「创建Skill」「找Skill」字面含 skill 却未命中 skill-creator/find-skills）**——其中向量能改写的语义混淆极少，评测作者第 75 行结论亦是「下一步先微调排序策略、非补基础设施」。故升级既有检索的必要性与收益须先以排序调优 + 复测验证（见 §九 风险10、§八 P3）。
> - `task.md` 早已注明「L3 向量检索后置」——本方案即补齐该缺口。

---

## 一、架构总览

```
渲染层                       主进程（全部能力收口，铁律 1/3：不裸 Node、密钥不出主进程）
─────────                   ─────────────────────────────────────────────────────────
window.one.kb.*  ──IPC──▶   main/vector/
                               ├── embed.ts       EmbeddingProvider 抽象（本地/远程可插拔）
                               ├── store.ts       向量索引 + SQLite 主表（存 chunks/向量/元信息）
                               ├── search.ts      检索（向量 / 混合 / 纯词法降级）
                               └── pipeline.ts    文档摄取（解析→分块→embed→入库）
                               └── tools/         内置工具：kb_search / kb_add / kb_remove
```

**核心决策 —— 全部向量操作只在主进程做**：
- 铁律 1：渲染层零 Node 特权；向量库/embedding/文档解析都是 Node/原生能力，必须主进程。
- 铁律 3：embedding API key 主进程 vault 侧持有，不外泄。
- 复用 `better-sqlite3` WAL + 迁移 + 损坏恢复体系（`storage/db.ts`），不另起数据库连接。

---

## 二、Embedding 来源：可插拔 Provider（默认本地，兼容远程）

**需求（用户确认）**：同时支持本地模型 + 远程 API 模型，**默认本地**。

| Provider | 形态 | 优点 | 代价 |
|---|---|---|---|
| **transformers.js** | 本地，库本体纯 JS/WASM | 离线、隐私、`@xenova/transformers`/`@huggingface/transformers` | ⚠️ "零原生编译"是早期宣传口径：**在 Electron 主进程/Node 路径下实际依赖 `onnxruntime-node`（原生 addon）而非纯 WASM**，ABI/打包需实测（见 §九 风险4）；仅 worker_threads + onnxruntime-web(WASM) 路径才真无原生编译；模型下载 ~100-300MB、CPU 编码慢、内存占用 |
| **onnxruntime-node（原生）** | 原生 addon（需 electron-rebuild） | 性能比 WASM 快 | ABI 重编（用现有 rebuild 一套）；更重 |
| **远程 OpenAI-兼容 API** | fetch，走 `/v1/embeddings` | 质量高、零本地负担、省内存 | 要联网、按 token 计费、key 权限 |

**首期实现顺序**：
1. **P1 先做「本地 transformers.js + 远程 OpenAI 兼容」两条具体实现，挂在统一 `EmbeddingProvider` 接口下**，默认走本地。
2. `EmbeddingProvider`（`src/main/vector/embed.ts`）：
   ```ts
   interface EmbeddingProvider {
     readonly kind: 'local' | 'remote'
     embed(texts: string[]): Promise<{ text, vector: Float32Array | null }[]>
     /** 预检：是否可用（本地模型已加载 / 远程已配 key+model） */
     ready(): Promise<boolean>
     dimension(): number
   }
   ```
3. 远程 Provider 复用现有供应商抽象（`Provider`/`ModelConfig`，`apiFormat: 'openai'` 已有 `/chat/completions` fetch 基础，照葫芦画瓢加 `/embeddings`）。模型可选：OpenAI `text-embedding-3-small`（1536）或 bge-mini over 中转。

**本地模型选择**（中文重点 + 体积权衡）：
- **默认取量化版小模型降低门槛**：中文建议 **量化的 bge-m3（~100MB）** 或更轻 `multilingual-e5-small` / `bge-small`（~40-90MB）；英文语料可用 `bge-small-en`。
- **体积与内存**：transformers.js 库本身随 app 走（<1MB）；大的是**模型权重**（量化的 ~100-150MB，fp32 更大）。**固化下载量化版**（fp16/quantized），体积减半、精度损失小。
- **维度**：取归一化后 float32 向量，维度内嵌在 provider 里（bge-m3 ≈ 1024；e5-small ≈ 384）。**换模型维度变 → 需 `kb:reindex` 定向重嵌**（见 §九 风险3）。
- **加载**：模型存于 userData（`app.getPath('userData')`），懒加载，不阻塞 app ready。

> **体积取舍（已确认）**：默认本地模型（因为部分用户没有云端模型，且可离线）。若体积/内存仍是痛点，提供**更小模型档位**（bge-small ~40MB）或**远程 provider 切换**作为用户可选项——但本地始终是默认。

**关键工程约束（P0 必建，评审补强）**：
- **推理必须移出主进程**：embedding 编码是 CPU 密集操作，严禁主线程同步 `encode`，须跑在独立推理上下文。依据：`CLAUDE.md` 铁律 23 已规定 Skill 脚本必须 async（worker_threads/child_process），同步会阻塞事件循环、groupchat 多 agent 并发时冻死；embedding 推理是同类问题，且被铁律 7 的 `Promise.all` wavefront 并发放大。`src/main` **已有成熟 async `child_process.spawn` 范式**（skillScript/shell/gh/poster/opencli，processKill 处理 detached+pgid）但**无 `worker_threads` 池**。**选型决策（P0 实测）**：embedding 是纯计算（非起外部子进程），`worker_threads`（进程内、通信成本低）vs `child_process`（起 node 子进程跑 transformers.js）二选一——transformers.js 在 worker 内的加载路径 / 主进程可见性 / electron-vite 打包 worker chunk 需实测，不可假定。reindex 后台重嵌复用同一推理上下文 + 进度回调。
- **模型分发与国内可达性**：`transformers.js` 默认从 `huggingface.co` 拉权重，国内 CDN 不可达。须将 `HF_ENDPOINT=https://hf-mirror.com` 设为**默认**（用户可配），否则国内首跑默认能力落空、退化为远程或纯词法。
- **中文质量早验（spike）**：quantized 小模型中文语义召回须先验证，不可等 P5。P0 末/P1 初用 `SKILL_RAG_EVAL` 的 22 条（或自造 20 条中文同义 query）跑 quantized bge-m3 的 Top3，对比词法基线；不过关早换模型/远程止损。
- **默认档唯一化**：中文默认即 quantized bge-m3（~100MB），不另设「升档到 bge-m3」的兜底循环（见 §九 风险2 改写）。
- **异步加载**：模型与向量索引均在 app ready 后**异步懒加载**，不阻塞启动。

**Embedding 就绪与完整降级链（硬性要求）**：

```
本地模型可用（已下载 + 已加载）
   │ 是 ────────────────▶ 向量检索 + 词法混合（最佳）
   │ 否（未下载 / 下载中 / 加载失败 / 网速差）
   ├─ 远程 embedding 已配置 ─▶ 远程向量（联网时生效）
   │      否
   └─ 兜底：纯词法检索（复用现有 FTS5 + LIKE + key）
        —— 功能不挂，仅缺语义召回，应用照常跑
```

1. `kb:status` 暴露整体就绪态：`embedding: 'ready' | 'downloading' | 'missing' | 'failed' | 'config-error'` + 下载进度。
2. **模型下不来 / 加载失败 → 自动回退到可用 provider**（已配远程用远程；否则纯词法兜底）。知识库照样能增/能查（FTS5），绝不让功能整体瘫痪。
3. **首验不阻塞**：记忆/技能原有 FTS 链路本就不依赖 embedding，应用启动即可用；`/kb` 页给就绪状态 + 下载进度 + 失败重试。
4. **后台重试**：下载失败后在设置/`kb:status` 提供「重试」，可后台定时重试，成功后把 pending 文档补向量化。
5. **远程 Provider 作为用户可配置的替代**，兼容「本地下不动 / 想要质量」的用户。

---

## 三、向量索引选型：先用「SQLite 主表 + 内存 Flat 暴力检索 + 可选 FTS 预过滤」

不首选 hnswlib-node / sqlite-vec 的理由（现有工程约束）：
- **hnswlib-node**：原生 addon，需 electron ABI 重编（虽然 `npm run rebuild` 已跑 better-sqlite3，但多一个原生库多一份构建/打包风险），且要序列化索引落盘。
- **sqlite-vec**：原生 SQLite 扩展，同样要 ABI/原生编译；虽然能复用 WAL，但首期引入的构建复杂度 > 收益。

**首期用「扁平暴力 cosine + SQLite 主表」**：
- 单用户桌面，知识库分块量级是**千到几万条**（十篇文档 × 每篇几十块），Flat 暴力 top-k 在几万条 × 1024 维时是毫秒级，完全够用；**不比引入 HNSW 的复杂度**。
- 向量以 BLOB/Float32Array 存 SQLite 主表 `kb_chunks`（复用 `better-sqlite3`），**内存建立数组索引**加速（`Float32Array` 存全部向量，cosine 用 `TypedArray` 点积，避免逐行反序列化）。
- **预过滤**：配和 FTS 词法预过滤（可选），抓中大规模 + 词组排除时退化到 FTS+向量混合。
- 超过预期量级（比如正式文档库 > 10 万块）再评估迁移 HNSW / sqlite-vec，接口预留 `VectorStore` 抽象（`insert/search/delete`），可换实现不动上层。

> **这是工程取舍**：先拿到「向量检索能跑、召回提升」的验证，再花精力上 ANN。避免首期就把 native 构建复杂度背在身上。

---

## 四、Schema（追加 `db.ts` migration，不新开库）

```sql
-- v10：知识库实体（文档分块 + 向量）
CREATE TABLE IF NOT EXISTS kb_chunks (
  id          TEXT PRIMARY KEY,          -- 形如 kb_{uuid}
  kb_id       TEXT NOT NULL,             -- 文档/知识库条目 id
  doc_id      TEXT NOT NULL,             -- 来源文档 id（可多个块同 doc）
  chunk_idx   INTEGER NOT NULL,          -- 块序
  content     TEXT NOT NULL,             -- 块文本
  vec         BLOB,                      -- Float32Array 向量（归一化，供 cosine）；vec IS NULL 时未向量化
  vec_dim     INTEGER,
  meta        TEXT,                      -- JSON（来源路径/标题/页码/标签/conf 等）
  created_at  INTEGER NOT NULL,
  UNIQUE(doc_id, chunk_idx)
);
CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(  -- 词法预过滤（hybrid 用），双列对齐 skills_fts
  chunk_id UNINDEXED, content_tokenized, content_raw UNINDEXED, doc_id UNINDEXED, tokenize='unicode61'
);
CREATE TABLE IF NOT EXISTS kb_docs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_path TEXT,       -- 本地文件路径（可空=手动录入）
  source_kind TEXT,       -- 'file' | 'clipboard' | 'export' | ...
  chunks INTEGER NOT NULL DEFAULT 0,
  embedding_provider TEXT, -- 记录用哪个 provider 产向量（dirty 重嵌用）
  created_at INTEGER, updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_kb ON kb_chunks(kb_id);
```

**见右侧要点**：
- `kb_docs` 记 `embedding_provider`，**换 embedding 模型可定向重嵌**（dirty 重嵌），防老向量与新 query 维度不匹配。
- `kb_chunks.vec` **可为 NULL**：模型下不来/离线时新摄取文档照常落库（content + FTS），仅 `vec` 为空，hybrid 检索时该块只词法命中；模型就绪后 `kb:reindex` 补齐向量——**配合 §二降级链，保证离线/网速差时知识库依然可用**。
- FTS5 表用于 hybrid 混合招（见 §六），双列对齐 `skills_fts`：`content_tokenized` 存 `tokenizeForFts(content)` 喂 MATCH、`content_raw` 存原文给 LIKE 兜底。⚠️ **长正文 bigram 权衡**：`tokenizeForFts` 为短 skill 元数据设计（单字+bigram），512 token 长正文做 char 级 bigram → tokenized 列体积 ≈ 正文汉字数×2 膨胀，FTS 索引变大；召回好但体积代价需 P1 实测膨胀比，过大可降级为单字（去 bigram）。
- 索引一致性自检在 `db.ts` 启动逻辑里加 `kb_chunks` 行数 vs FTS 行数比对（照 `reindexL3Fts` / `reindexSkillsFts` 范式）。
- **P3 的 L3/skills 向量 schema 决策（v10 缺口，已定）**：`memory_l3` / `skills` 若加向量召回，向量**独立迁移加 `vec BLOB` 列**（非 keyed 进 `kb_chunks`）——理由：L3 是 KV 语义、skills 是元数据语义，与 kb_chunks 的「文档分块」实体不同构，复用 kb_chunks 反耦合；各自内存索引解耦、按实体一索引设计。v10 当前**未包含** `memory_l3.vec` / `skills.vec`，P3 落地时另开迁移加列，P0 的 `VectorStore` 抽象按「每实体一索引」设计（`insert/search/delete` 带实体类型参数）。
- **内存索引硬上限 + 超限中间态**：内存 `Float32Array` 全量索引 = 4KB/条（与磁盘 BLOB 同口径）；30 万条 ≈ 1.2GB RAM，非「几百 MB」。设上限（≤ 2 万条全内存，app ready 后异步懒加载建索引，避免冷启动卡顿）。**超上限的中间态动作（P2-P5、HNSW 未上前）**：按 `kb_id`/`doc_id` 分片内存，查询时只扫命中文档分片（先 FTS/MMR 过滤候选 doc 再向量扫其分片），候选数仍可控；分片也超限则该次检索**退化纯 FTS5**（配合 §二降级链，不崩）。P6 上 HNSW 后此分路径作废。

---

## 五、分块（pipeline）与摄取

`src/main/vector/pipeline.ts`：

1. **解析**：`file_read` 已有围栏能力；首期支持 **md / txt / json**（纯文本）与极简 **pdf/doxx** 走正文抽取（若不做可先仅文本，降级明确写死）。URL/网页可由 `summary_reader`/`web_read` 先取文本。
2. **分块策略**：
   - 默认 **固定窗口 512 token（约 500-800 汉字）** + **重叠 64 token**，用 Markdown 标题打断点（`#` 段落优先）。
   - 复用现有 token 预算逻辑（`src/main/llm/token-count.ts` 的 `approxTokenCount`，非 tiktoken、~10-20% 误差，storage 已在用），避免 LLM 上下文超纲。
   - 分块后生成简洁 `title/草` 元数据，便于检索回 + 溯源。
3. **向量化**：对每个 chunk 调 `EmbeddingProvider.embed`，非本地时走远程；失败 chunk 标记 null，检索时该 chunk 只能词法命中。
4. **入库**：`db.transaction` 批量写 `kb_chunks` + FTS + 更新 `kb_docs.chunks`。**幂等**：同 `doc_id` 重取摄 → 先删旧块。

**工具暴露（Agent 按需检索，不塞 prompt）**：
- `kb_search({ query, k?, filter? })` —— 向量 + 词法混合招，返回 `[{ kb_id, doc_id, title, chunk, content, score, source }]`，Top-k。
- `kb_add({ title, content, source? })`：写入一段文本（或文档）作为知识库条目，自动分块向量化。
- `kb_remove({ doc_id })` / `kb_list()`：管理。
- `kb_find_docs`：分类检索（按文档维度聚合，返回该文档内相关块）。
（若一次招太多，先 `kb_search` + `kb_add` 即可闭环，管理类用后台页面而非工具。）

---

## 六、混合检索（hybrid）——召回融合

每个 `kb_search` 执行：
1. **向量召回**：query 向量 × 各块向量 cosine（内存 FlatIndex），记 score_vector。
2. **词法召回**：`kb_chunks_fts` 走 `tokenizeForFts` BM25，记 score_lex（已有范式）。
3. **融合**：采用**倒数排名融合（RRF）**：`score = Σ 1/(k+rank)`（k 默认 60），按各路召回的 rank 融合，去重按 chunk_id。RRF 与分值尺度无关、对 `vec` 为 NULL 的离线块天然鲁棒（见 §四）——NULL-vec 块根本不进向量候选集，故 RRF 只计其词法 rank `1/(k+rank_lex)`，缺项路不产生分值、无尺度不公，比 weighted sum 更公平、更简单，是 hybrid 检索标准做法。
4. **兜底（配合 §二降级链）**：embedding 不可用（本地未下载/失败、且无远程兜底）→ 该次检索退化纯 FTS5；`vec` 为 NULL 的存量块本就只走词法；FTS5 失败再兜底 LIKE。模型就绪后 `kb:reindex` 补向量、自动恢复完整 hybrid。

升级既有最简：
- **L3 memory**：`src/main/storage/memory/l3.ts` 的 `searchL3` 增加一个向量召回路（内存 L3 向量索引），与现有 key/FTS/LIKE 三路合并；`memory_retain` / `saveL3` 时同步 `embed(vector)`。
- **skill**：`searchSkills` 加向量召回（**P3 可选，有证据再议**）——`SKILL_RAG_EVAL` 5 错例多为排序/词汇而非同义，向量对 skill 真实增量趋近 0（见 §九 风险10）；先零成本调权重复测，确有余量再上向量，**不预设「用它救」**。

> 混合检索是改进词法召回的**最小侵入改动**——不推翻现有 FTS5 招，而是「向量 + 词法」融合。**对文档知识库 RAG，hybrid 是召回提升的主要手段**；skill/L3 既有检索则先调权重（见风险10），不预设向量必救。

---

## 七、IPC / preload / 前端

- `src/main/ipc/knowledge.ts`：`kb:search` / `kb:add` / `kb:remove` / `kb:list` / `kb:listDocs` / `kb:reindex` / `kb:status`（provider 就绪状态/dim/条数）。
- `preload/index.ts` 追加 `window.one.kb.*`（`Promise<IpcResult<T>>`）。
- 前端：`/kb` 独立页（与 `/models` `/mcp` 平行），列表文档 + 上传/新建 + 检索预览 + embedding Provider 状态开关。不硬塞主 agent——它会通过工具按需检索。
- i18n：新增 `kb` namespace（双语），错误码进 `errors.*`。

---

## 八、分阶段落地

- [ ] **P0 地基**：`EmbeddingProvider` 接口 + `transformers.js` 本地实现（懒加载模型）+ `embed.ts`；`kb_chunks`/`kb_docs`/`kb_chunks_fts` migration（v10）+ `vectorStore` 抽象 +「内存 FlatIndex + SQLite BLOB」读写。
  - **P0 必建子项（评审补强）**：
    - 推理 worker（worker_threads 或 child_process，P0 实测选型），embedding 推理不在主线程同步算；
    - `HF_ENDPOINT=https://hf-mirror.com` 默认（可配），保证国内首跑可达；
    - 中文质量 spike（22 条 / 20 条同义 query 跑 quantized bge-m3 Top3）验证召回；
    - RRF 融合（替代 weighted sum），对 NULL-vec 离线块公平；
    - 内存索引硬上限（≤ 2 万条全内存，超出落盘 ANN/分页）+ app ready 后异步懒加载 + 维度漂移启动自检；
    - P3 的 L3/skills 向量 schema 决策（见 §四，已定：独立迁移加 `vec` 列，非 keyed 进 `kb_chunks`）。
- [ ] **P1 摄取**：`pipeline.ts`（md 分块 + MD heading 打断 + overlap）+ `kb_add`/`kb_list`/`kb_remove` pipeline IPC。
- [ ] **P2 检索闭环**：`vector.ts` cosine + `hybrid` 融合 + `kb_search` 工具 + `/kb` 前端页 + `kb:status` 就绪态。
- [ ] **P3 升级既有（可选 / 有证据再议）**：`memory_l3` / `skills` 检索加向量召回（hybrid），`memory_retain`/`saveSkill` 挂 embedding 双写。**前提**：先按 `SKILL_RAG_EVAL` 建议做排序/权重调优（零成本），用同 22 条评测集复测，确有余量再上向量；L3 除非有语义召回失败证据否则不碰向量（见 §九 风险10）。
- [ ] **P4 远程 Provider**：OpenAI `/embeddings` 适配，供应商可配置（键 vault）；Provider 切换触发 `kb:reindex` 定向重嵌。
- [ ] **P5 文档摄取扩展 + 评测**：pdf/docx 抽取、URL 摄取；用 `SKILL_RAG_EVAL` 同款评测集跑向量混合版对比（召回 Top1/Top3 应显著高于词法）。
- [ ] **P6（可选)**：量大再换 HNSW / sqlite-vec（换 `VectorStore` 实现，不动上层）。

---

## 九、风险与待确认

1. **本地模型体积/首载**：bge-m3 等 ~100-150MB；首次加载（WASM quantize）偏慢（数秒）。**缓解（硬性，见 §二降级链）**：懒加载 + `kb:status` 就绪态 + 下载进度/失败重试 + 自动回退远程 → 无远程则纯词法兜底，**功能永不因模型下不来而瘫痪**。
2. **中文 embedding 质量**：默认即 quantized bge-m3（~100MB），已在 P0 spike 验证中文召回（见 §二）。若实测仍不达标，提供**更大模型档位**或**远程 provider**作为用户可选项，**不循环默认档**（消除原「升到 bge-m3」兜底矛盾）。
3. **维度漂移**：换 provider/模型须重嵌（`kb_docs.embedding_provider` + `kb:reindex`），否则维度不一 cosine 报错。重嵌为**后台队列 + 进度回调**，复用 §二 推理 worker；10k 块本地 WASM 重嵌为分钟级，严禁同步跑阻塞主线程。启动自检：`vec_dim` ≠ 新 provider 维度 → 强制 reindex，避免运行时报错。
4. **electron-builder / native rebuild（ABI）**：首版纯 WASM + 纯 JS，无新增原生依赖。**注意**：`transformers.js` 在 Electron **主进程(Node)** 跑到底用 `onnxruntime-node`（原生 addon）还是 `onnxruntime-web`（WASM）需实测——「零原生编译」对 Node 主进程路径过于乐观，electron-vite 打包 WASM + 模型资源 + 动态 import 有真实踩坑成本，须 P0 实测验证。真正碰 ABI 仅当换 hnswlib/sqlite-vec（P6 可选）。
5. **磁盘 / 内存**：磁盘 Float32 1024 维 × 每条 4KB，几十万块约 1GB 量级，可接受。但**内存全量索引同口径 = 4KB/条**（非磁盘专属）——30 万条 ≈ 1.2GB RAM，绝非「几百 MB」。须设内存硬上限（见 §四 / §八 P0），超出落盘 ANN/分页。
6. **隐私/离线**：默认本地模型可完全离线；远程则同现有 LLM key 安全模型（主进程 vault，铁律 3）。
7. **i18n**：`kb.*` 命名空间双语 + `errors.*` 补齐。
8. **主线程阻塞（铁律 23 同类）**：embedding 推理若在主线程同步算，批量摄取（几十~几百 chunk）会阻塞事件循环数秒，IPC/托盘/自动更新/前端全冻；groupchat 多 agent 并发 `kb_search` 时推理串行化 → 冻死。已通过 §二 推理 worker 规避（不在主线程同步算）。
9. **内存 RAM 上限（修正原口径）**：见风险5，索引内存成本被原方案低估，已设上限 + 异步懒加载。
10. **升级既有检索的必要性待验证**：`SKILL_RAG_EVAL` 5 错例经拆解实为 2 排序 + 1 近义混淆 + 2 词汇意图匹配，Relaxed Top3 口径仅 2/22 失败且均为「skill」字眼词汇问题；向量对 skill 检索真实增量趋近于 0，评测作者结论也是「先调排序非补基建」。故 P3 升 L3/skills 向量标为「可选 / 有证据再议」，先零成本调权重复测。

---

## 十、与现有体系的关系

| 现有件 | 本方案改造 |
|---|---|
| `memory_l3` + `searchL3`（FTS 三路） | + 向量召回（hybrid）；`memory_search` 描述不变，肉眼可见变准 |
| `skills_fts` + `searchSkills` | + 向量召回（hybrid，**P3 可选，收益待复测验证**）；非「大幅降低」承诺 |
| 模型供应商 `Provider`/`ModelConfig` | 给远程 provider 预留 embedding model 字段（P4） |
| `better-sqlite3` db.ts migration env | 追加 v10 三表，WAL/备份/自检全复用 |
| 工具注册 `tools/registry` | 新增 `kb_search/kb_add/kb_remove` 走同一 registry（approvalMode 视读写可配） |