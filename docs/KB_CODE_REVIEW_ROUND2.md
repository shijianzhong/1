# 向量化知识库（KB）深度 Review — 第二轮发现清单

> 范围：`f308a8d..aa51d1a` 四个 commit（向量知识库 P0–P5 + slim/full 双发 + full 通道自动更新），约 9630 行 diff。核心审查 `src/main/vector/*`（store / flat-index / search / rrf / kb-fts / embed / worker-client / worker-embed.cjs / reindex / pipeline / extract / download-model）+ `ipc/knowledge.ts` + `db.ts` v10/v11 migration + `preload` + `KbPage.tsx` + `hooks.ts`。
>
> 方法：① 逐文件通读全部核心实现；② 跑 `vitest src/main/vector`（10 文件 99 例全绿）；③ 派两条独立核查 fork（search docIds 裁剪 / extract 嵌套列表 + worker 全零向量 + embeddingProvider 口径），结论全部二次验证属实；④ 跑 `code-review` skill（8 finder 并行 + dedup + 1-vote verify），6 confirmed / 2 refuted。本文 12 条发现均为代码事实二次验证后的结论，不存推测。
>
> 与 [`KB_CODE_REVIEW.md`](./KB_CODE_REVIEW.md) 的关系：第一轮（2026-08-20）复核已确认 P0-1/P0-2/P0-3 三个阻断 bug 全修 + P1–P5 验收 + 4 个 P2+ 优化项。本轮在第一轮基础上深挖，**新发现 6 个 P0 级正确性 bug + 2 个中低 + 4 个效率/复用**——第一轮均未覆盖。**诚实标注：第 1/2/4/5/6/9–12 条是 code-review skill 的多角度 finder 抓到而我独立通读时漏掉的（已逐条二次验证属实），第 3/7/8 条是我独立 + fork 核查抓到、code-review 未列。** 降级链注释不可信是本轮最大教训（#1 注释主动误导）。
>
> 结论总览：设计闭环与降级哲学成立，但**#1（flat-index 写入后不 reload）是 P0 级阻断——新摄取文档的向量在搜索中静默失效直到重启**，必须先修。其余 5 个 P0 触发概率/影响递减但语义确错。2026-08-22 并入并行 review 的 #22–#27 无 P0（#22 worker 卡死不杀为最需关注 P2）。建议按 §修复顺序动工。
>
> **2026-08-21 合并外部 review**：本文件已并入另一路独立 review 的 9 条发现（#13–#21，见「补充发现」节）——其中 **#13（seedKbModel 部分拷贝恢复失效）与 #14（前端 onAdd/onPickFile/onRemove 静默失败）为 P1**，其余为 P2/nit。合并后速查表 21 条 + 非阻断 5 条，修复顺序已更新（#1/#6/#2/#13/#4/#5/#14 优先）。
>
> **2026-08-22 合并本项目并行 review**：再并入本项目一轮工作流并行 review 的 6 条发现（#22–#27，见「补充发现 · 并行 review」节）——均为 worker 健壮性 / 死代码 / 幂等边角，无 P0，`#22`（worker 卡死不杀、检索热路径永久退化纯词法）为最高 P2，建议尽快处理。合并后速查表 27 条 + 非阻断 5 条。

---

## 严重度速查表

| # | 严重度 | 位置 | 一句话 | 来源 |
|---|--------|------|--------|------|
| 1 | P0 阻断 | `flat-index.ts:159` | 写入后 invalidate 不 reload，向量搜索静默失效直到重启 | code-review（我漏） |
| 2 | P0 | `embed.ts:177` | 远程 embed 不校验响应长度，截断响应静默产 null | code-review（我漏） |
| 3 | 中低 | `flat-index.ts:173` + `search.ts:74` | 非分片库 searchFlat 忽略 docIds，限定检索少于 topK | fork1 + code-review |
| 4 | P0 | `pipeline.ts:252` | insertKbChunks + upsertKbDoc 双事务，崩溃留孤儿 chunk | code-review（我漏） |
| 5 | P0 | `pipeline.ts:114` | 未闭合 fence 无界推进，产超长 chunk 无 maxTokens 再校验 | code-review（我漏） |
| 6 | P0 | `worker-embed.cjs:239` | handleRequest 无 init-promise 去重，首 init 窗口并发重复加载模型 | code-review（我漏） |
| 7 | 中 | `extract.ts:152` | htmlToMarkdown 嵌套列表错位，docx 多级列表粘连 | fork2（code-review 未列） |
| 8 | 低 | `pipeline.ts:260` | ingest 写本地模型 id 不论 provider，per-doc badge 错 | fork2（code-review 未列） |
| 9 | 效率 | `embed.ts:239` | hasLocalModel 每次搜索做 recursive readdir | code-review（我漏） |
| 10 | 复用 | `extract.ts:197` | extractFromUrl 重复 web.ts fetchText，漏 4xx/5xx 分流 | code-review（我漏） |
| 11 | 复用 | `extract.ts:180` | stripTags/decodeEntities 重复且漏实体 | code-review（我漏） |
| 12 | 效率 | `download-model.ts:71` | 裸 fetch 无重试，一次 503 杀掉整个模型下载 | code-review（我漏） |
| 13 | P1 | `storage/builtin.ts:113` | seedKbModel 首启复制 23MB 中途崩溃 → 残留半截 .onnx → 下次启动误判已存在跳过复制，模型永久损坏 | 外部 review（2026-08-21 合并） |
| 14 | P1 | `KbPage.tsx` onAdd/onPickFile/onRemove | 三个 mutation 无 onError + QueryClient 无全局兜底 → 文件超限/类型不支持/抽取失败时用户零反馈（静默 unhandled rejection） | 外部 review（2026-08-21 合并） |
| 15 | P2 | `download-model.ts:84` | 流式落盘无大小上限（与 #12 无重试是不同维度） | 外部 review（2026-08-21 合并） |
| 16 | P2 | `db.ts:291` | v11 `ALTER TABLE ADD COLUMN` 非幂等（唯一非 IF NOT EXISTS 的 migration），列已存在则每次启动迁移失败 | 外部 review（2026-08-21 合并） |
| 17 | P2 | `KbPage.tsx:152` | onProviderChange 错误写进 searchError，显示在搜索区而非 provider 区 | 外部 review（2026-08-21 合并） |
| 18 | P2 | `hooks.ts:212` | useKbProviderPreference 死代码，从未被 import | 外部 review（2026-08-21 合并） |
| 19 | P2 | `reindex.ts:133` | cancelReindex 不清 kb_reindex_required 标志 → 取消后 UI 持续提示 reindex | 外部 review（2026-08-21 合并） |
| 20 | P2/nit | `embed.ts:321` | checkVecDimDrift 只采样一行（LIMIT 1），混合维度库可能漏检 | 外部 review（2026-08-21 合并） |
| 21 | nit | `kb.json` | kb:doc.removeConfirm 死 i18n key（双语均有） | 外部 review（2026-08-21 合并） |
| 22 | P2 | `worker-client.ts:179-206,43` | 批超时只 reject 不 kill 卡死 worker，检索热路径永久退化纯词法直到重启 | 并行 review（2026-08-22 合并） |
| 23 | P2 | `worker-client.ts:186-191` | abort 监听器 `{once:true}` 正常完成不移除，长存活 signal 逐批累积 | 并行 review（2026-08-22 合并） |
| 24 | P2 | `embed.ts:163` | RemoteEmbeddingProvider 无超时上限，黑洞化 provider 可无限挂起 | 并行 review（2026-08-22 合并） |
| 25 | nit | `db.ts:470` | `kb_vec_dim` app_meta 死写（无读取者）+ `BGE_M3_DIM` 陈旧注释 | 并行 review（2026-08-22 合并） |
| 26 | P3 | `kb-fts.ts:94-108` | FTS LIKE 兜底不按剩余配额截断，可达 ~2×topK，RRF 向词法倾斜 | 并行 review（2026-08-22 合并） |
| 27 | nit | `ipc/knowledge.ts:109` | 原生文件对话框硬编码中文「选择文档」（与既有 skills.ts 同范式） | 并行 review（2026-08-22 合并） |

---

## P0 — 必须修的正确性 bug（6 条）

### #1〔最严重〕flat-index 写入后不 reload，向量搜索静默失效直到重启

**位置**：`src/main/vector/flat-index.ts:159`（`search()` 不调 `load()`）+ `store.ts:130`（`invalidate()`）+ `store.ts:129`（注释撒谎）

**现象**：`search()` 入口 `if (!this.loaded || this.dim === 0) return { results: [], degraded: false }`——未加载时返回空且 `degraded=false`，**从不调用 `load()`**。`load()` 只在 `initFlatIndex()` 被调，而 `initFlatIndex()` 只在 app 启动（`embed.ts` `initKbStatus`）和 reindex 结束（`reindex.ts:112`）时调。`insertKbChunks`/`deleteKbDoc` 调 `flatIndex.invalidate()` 把 `loaded` 置 false、`dim=0`，但无 warm。

**失败场景**：
1. 用户 `kb:add` 摄取文档 → `ingestDocument` → `insertKbChunks` → `flatIndex.invalidate()`（`loaded=false`, `dim=0`）
2. 用户立刻 `kb:search` → `searchKbHybrid` → `searchKbVectors` → `flatIndex.search()` → `if (!this.loaded) return { results: [], degraded: false }`
3. 向量路空、`degraded=false` → RRF 只融合 FTS 命中 → **新摄取文档的向量永远不会在搜索中出现，直到 app 重启（`initKbStatus`）或手动 reindex**
4. 前端显示"混合检索"（无 degraded badge，因 `degraded=false`），用户无感知

**注释误导**：`store.ts:129` 注释声称「P0 最简：下次 search 触发重载」——**注释撒了谎，`search()` 根本不 reload**。这是本轮 review 最大的教训：降级链的注释不可信，必须追实际调用链。

**影响**：新摄取文档搜不到（最常见操作路径），违背「摄取即可检索」的产品预期。单用户桌面场景 app 长期不重启，bug 长期潜伏。

**修复方向**（二选一，推荐前者）：
- `search()` 在 `!loaded` 时先 `this.load()` 再查（惰性重载，与注释承诺一致）
- 或 `invalidate()` 后主动 `initFlatIndex()` warm（写入即 warm，但批量摄取时多次 warm 浪费）

回归：新增测试「insertKbChunks 后立即 search → 命中该 chunk」（现有 `flat-index.test.ts` 无此覆盖，因都先 `load()` 再测）。

---

### #2 RemoteEmbeddingProvider.embed 不校验响应长度，截断响应静默产 null

**位置**：`src/main/vector/embed.ts:177-184`

**现象**：`json.data.map((d) => ...)` 按实际响应条数产出向量数组，不校验 `out.length === texts.length`。远程 provider 因 max-input 限制静默截断（如发 512 条只回 100 条）→ `out` 只有 100 项 → `pipeline.ts:242` `vecs[i] ?? null` 对 `i=100..511` 得 undefined → `?? null` → 412 个 chunk 静默 `vec=NULL`，无 warning。

**失败场景**：用户配远程 OpenAI provider，摄取一篇长文档分 512 块 → 远程 `/embeddings` 因 `max_input_tokens` 截断返回 100 条 → 412 块 vec=NULL → hybrid 检索时这 412 块只词法命中 → 用户看到 KB"只有 ~20% 块向量化"，无任何错误信号（`degraded` 只反映 query 时 provider 是否就绪，不反映 ingestion 时是否截断）。

**影响**：静默召回质量下降，用户难定位。

**修复方向**：映射后 `if (out.length < texts.length) { logger.warn(...); out = [...out, ...Array(texts.length - out.length).fill(null)] }` 补 null 到等长 + warn；或映射前 `if (json.data.length !== texts.length) return texts.map(() => null)` 全量失败降级（更保守）。前者保留已成功部分，后者更安全。

---

### #3 非分片库 searchFlat 忽略 docIds，限定范围检索返回少于 topK

**位置**：`flat-index.ts:173-188`（`searchFlat` 不过滤 docIds）+ `search.ts:74-79,112-116`（fetch 后裁剪）

**现象**：非分片态（chunk ≤ HARD_CAP=20000，常见情况）`searchFlat` 全扫所有向量，**完全不参考 `opts.docIds`**，返回全库 topK。这些候选（含 docIds 外文档）进入 RRF 融合后被 `rrfFuseTopN(channels, topK)` 截断到 topK；最后回表阶段 `if (docIdSet && !docIdSet.has(c.docId)) continue` 才裁剪——此时 docIds 外候选已占满 topK 名额被丢弃，**本该从 docIds 内候选补足却不会补**，最终返回 < topK 条。

**失败场景**：库有 500 文档（未超 20000，非分片）。用户/agent 传 `docIds=['doc_42']` 限定检索。`searchKbVectors` 调 `flatIndex.search(qVec, {docIds, topK})` → `searchFlat` 扫全 500 文档返回全局 cosine top-5。若 top-5 都不属于 doc_42，fetch 后过滤全丢 → doc_42 向量命中 0，即便 doc_42 有块排在全球第 6–10。

**触发概率**：低。前端 `KbPage.onSearch` 只传 `{query, k:5}` 不传 docIds；`kb_search` 工具的 docIds 是 optional，agent 通常不传。但语义确错：传了 docIds 期望限定范围 + 返回 topK，实际可能少返回。

**注意**：sharded 态（>20000）`searchSharded` 在有 docIds 时只扫命中文档分片、无 docIds 时 degraded 走纯词法——两条路径都不会召回 docIds 外候选。**只有非分片 + 有 docIds 这一组合是漏洞**。task.md:219-220 已记为 P2+ 优化项。

**修复方向**：`searchFlat` 接受 docIds，点积循环时按 `id→docId` 映射跳过 docIds 外候选（需 flat-index 持有 `ids→docId` 映射，或 search.ts 融合前对向量候选预过滤——后者需回表有开销，前者更干净）。

---

### #4 insertKbChunks + upsertKbDoc 双事务，崩溃留孤儿 chunk

**位置**：`src/main/vector/pipeline.ts:252-253`

**现象**：`insertKbChunks(records)`（内部自带 `db.transaction`，store.ts:104）和 `upsertKbDoc({...})`（独立 `prepare.run`，store.ts:135）是**两个独立事务**，无外层包裹。两步之间崩溃 → `kb_chunks` 有行、`kb_docs` 无行。

**失败场景**：进程在 `insertKbChunks` 提交后、`upsertKbDoc` 提交前崩溃（断电/OOM/SIGKILL）→ `kb_chunks` 存在该 doc_id 的块，`kb_docs` 无该文档元信息。`kb:list` → `listKbDocsLite` 只 `SELECT FROM kb_docs` → 孤儿文档**永不出现在列表，用户无法从 UI 删除**。无启动孤儿扫描。孤儿 chunk 却被 `flatIndex.load()` 和 FTS（都直接查 `kb_chunks`）加载，消耗索引内存、在 topK 融合中挤占合法结果。

**影响**：孤儿不可见不可删，污染索引；长期累积。

**修复方向**：`ingestDocument` 末尾用 `db.transaction(() => { insertKbChunksInTx(records); upsertKbDocInTx(doc) })` 包成单事务（需 store 暴露事务内可调的版本，或 pipeline 持有事务句柄）；或启动加孤儿扫描（`SELECT DISTINCT doc_id FROM kb_chunks WHERE doc_id NOT IN (SELECT id FROM kb_docs)` → 清理 + warn）。前者根治，后者兜底。

---

### #5 splitByTokenWindow 未闭合 fence 无界推进，产超长 chunk

**位置**：`src/main/vector/pipeline.ts:114-118`

**现象**：fence 守卫 `while (end < lines.length && !fenceRe.test(lines[end])) end++` 在找不到闭合 fence 时推进到 `lines.length`，随后 `end++` 再越界，整个剩余 section 作为单块 `chunks.push(lines.slice(i, end).join('\n'))`，**无 maxTokens 再校验**。

**失败场景**：markdown section 含一个开 ```` ``` ```` 但无闭合（畸形/部分抽取自 docx/文件截断）：`depth` 检查从 line 0 数 fence 标记，见 `depth=1`（奇）于 chunk 边界 → 触发 `while` 找闭合 fence → 找不到 → `end` 推到 `lines.length` → `end++` 越界 → 整个剩余 section 推为单块。该 chunk 可远超 maxTokens（512）→ embedding 模型截断或失败，且 overlap 切分未对该最终块生效。

**影响**：超长 chunk 致 embedding 截断/失败，召回质量受损。

**修复方向**：推进后加 `if (approxTokenCount(chunk) > maxTokens)` 再走 `splitByTokenWindow` 兜底硬切；或对未闭合 fence 视为普通文本（`depth` 检测到末尾仍奇数 → 当作已闭合处理，不无界推进）。

---

### #6 worker handleRequest 无 init-promise 去重，首 init 窗口并发重复加载模型

**位置**：`src/main/vector/worker-embed.cjs:239-243`

**现象**：`handleRequest` 用裸 `if (!initialized) { await init(); initialized = true }`，无 init-promise 去重。`init()` 加载 ~23MB ONNX 模型 + tokenizer 需 ~1-2s。期间若多个 batch 并发到达（worker 的 `data` handler `handleRequest(req)` 不 await，line 280 逐行投递），每个都读 `initialized===false`，都进 `init()`。

**失败场景**：reindex 首批 init 运行时（~1-2s worker 内），renderer 并发 `kb:search` → 两路都经共享单 worker → 两个 `handleRequest` microtask 都 `await init()` → **加载 ~23MB 模型两次，内存翻倍**。内存受限机器或换大模型（bge-m3 1024 维）可能 OOM。

**修复方向**：`let initPromise = null; if (!initPromise) initPromise = init(); await initPromise; initialized = true`（promise 去重，所有并发 batch 共享同一 init）。

---

## 中低 — 显示 / 口径 bug（2 条，独立核查抓到、code-review 未列）

### #7 htmlToMarkdown 嵌套列表错位

**位置**：`src/main/vector/extract.ts:152-161`

**现象**：`htmlToMarkdown` 用正则 `/<ul[^>]*>([\s\S]*?)<\/ul>/` 处理列表，非贪婪 `([\s\S]*?)` 会匹配到**内层第一个 `</ul>`**。mammoth 对 docx 多级列表（大纲/条款）输出真正的嵌套 HTML `<ul><li>A<ul><li>B</li></ul></li></ul>`。

**失败场景（实测）**：输入 `<ul><li>顶层A<ul><li>子B</li><li>子C</li></ul></li><li>顶层D</li></ul>` → 输出 `"- 顶层A子B\n- 子C\n顶层D"`——顶层 A 与子 B 粘连、顶层 D 丢失 `-` 前缀、层级完全错位。docx 多级列表不罕见（大纲/条款/编号嵌套），错位污染分块内容、拖累检索质量。

**修复方向**：嵌套列表需递归处理（`<ul>`/`<ol>` 替换时对 inner 递归再映射），或改用真正的 HTML parser（如 `node-html-parser`，体积小）。

---

### #8 ingest embeddingProvider 口径不一致，per-doc badge 错

**位置**：`src/main/vector/pipeline.ts:260`（写本地模型 id）vs `reindex.ts:107-108`（回标真实 provider）

**现象**：`ingestDocument` 写 `upsertKbDoc({ embeddingProvider: KB_MODEL_ID })`，`KB_MODEL_ID` 恒为本地模型 id `'Xenova/multilingual-e5-small'`，**不论当前活跃 provider 是 local 还是 remote**。reindex 完成后用 `updateKbDocsEmbeddingProvider(providerTag)` 覆盖为真实 provider（remote 标 modelId、local 标 'local'）。

**失败场景**：用户配远程 provider 直接摄取（未 reindex）的文档，`kb_docs.embedding_provider` 列存 `'Xenova/multilingual-e5-small'`（本地模型 id），但实际向量是远程模型产的。前端 `KbPage` per-doc provider badge 显示错误值。reindex 后自愈。

**影响**：仅显示错误。`getKbStatus().embeddingModel` 读全局活跃 provider（`embed.ts:301` `provider.kind === 'remote' ? provider.modelId : null`），不受影响；检索/向量化正确性不受影响。

**修复方向**：`ingestDocument` 写 `embeddingProvider` 时按 `getActiveProvider()` 算真实 providerTag，与 reindex 同口径（抽出 `providerTagFor(provider)` helper 共用）。

---

## 效率 / 复用（4 条，code-review 抓到，我漏大部分）

### #9 hasLocalModel 每次搜索做 recursive readdir

**位置**：`src/main/vector/embed.ts:239`（`hasLocalModel`）→ `LocalEmbeddingProvider.ready()`（`embed.ts:53`）

**现象**：`hasLocalModel()` 做 `readdirSync(dir, { recursive: true })` 扫 `.onnx`。`ready()` 在每次 `kb:search`（`search.ts:64`）、`kb:status`、ingestion 都调。结果在会话内不变（模型只经 `downloadKbModel`/`seedKbModel` 出现）。

**影响**：每次混合搜索在主线程同步递归读模型目录一次，agent 工具循环调用时累积 I/O 延迟。

**修复方向**：首次后缓存 `ready` 结果，`downloadKbModel`/`seedKbModel` 完成后失效缓存。

---

### #10 extractFromUrl 重复 web.ts fetchText，漏 4xx/5xx 分流

**位置**：`src/main/vector/extract.ts:197-233`

**现象**：timeout+AbortController+Jina Bearer header 逻辑逐字复制自 `src/main/tools/builtin/web.ts` fetchText。extract 副本对任何 `!res.ok` 都 throw，故 Jina 的 401/429 与 web.ts 行为分叉（web.ts 重试/结构化错误，extract 抛并中止整个 URL 摄取）。两份相同 timeout/清理边界面的副本会漂移。

**修复方向**：从 `web.ts` 导出 `fetchText`（或抽到 `src/main/util/http.ts`），此处传 Jina URL + Bearer header 调用。

---

### #11 stripTags/decodeEntities 重复且漏实体

**位置**：`src/main/vector/extract.ts:188`（`stripTags`）+ `180-186`（实体解码）

**现象**：`stripTags` 与 `web.ts:72-74` 字节级重复。手写实体解码只覆盖 `&nbsp;/&amp;/&lt;/&gt;/&quot;/&#39;`，是 `web.ts decodeEntities`（覆盖 named + numeric + hex）的子集。docx/HTML 抽取丢 `&hellip;/&mdash;/&#8230;` 等 web 工具保留的实体。

**修复方向**：从 `web.ts` 导出 `stripTags`+`decodeEntities`，此处 import。

---

### #12 download-model 裸 fetch 无重试

**位置**：`src/main/vector/download-model.ts:71-79`

**现象**：`fetch(url)` 一次，非 2xx/404 即 throw。多文件模型下载中一次瞬时 503/网络抖动中止整个序列，无退避。隔壁 `src/main/llm/retry.ts:33-89` 已实现 `isRetryable()+computeDelay()+sleep()` 含 jitter，keyed on 429/5xx/网络错。用户「下载模型」按钮脆，而 LLM 路径优雅重试。

**修复方向**：把 retry 的 `isRetryable`/`computeDelay`/`sleep` 抽成共享 http-fetch helper，或在此处对 per-file fetch 包重试循环复用这些 helper。

---

## 独有非阻断（我抓到，code-review 未列）

- **download-model.ts:25 MODEL_ID 重复硬编码**：与 `worker-client.ts:155` `DEFAULT_MODEL_ID` 各自硬编码 `'Xenova/multilingual-e5-small'`，没复用同一常量源。改模型要改多处易漏。FILES 列表与 fetch-kb-model.mjs 一致，但 MODEL_ID 单点没统一。
- **flat-index.ts:186 heap.sort 废了堆用途**：`searchFlat` 用小顶堆维护 Top-k（注释说"避免全排序 n·log(n)"），但最后 `heap.sort((a,b) => b.score - a.score)` 还是做了 k·log(k) 排序。堆只省了维护阶段（O(n·log k) vs O(n·log n)），非正确性问题，注释略有误导。
- **reindex/downloadModel 缺并发守卫**：用户连点可起多实例。`reindexController` 模块级单例只在 `runReindex` 内赋值，并发第二次调用覆盖 controller 引用，第一个 reindex 的 abort 信号丢失。（KB_CODE_REVIEW.md:155 已记）
- **degraded 0 候选时 false**：向量路 ready+embed 成功但 0 候选（flat-index 空）时返回 `degraded=false`（标"混合"非"纯词法"），轻微不精确。（KB_CODE_REVIEW.md:120 已记）
- **terminateEmbedWorker setTimeout 在退出流里失效**：`before-quit` 同步流调 `terminateEmbedWorker`，内部 `setTimeout(() => killProcessGroup(w.child), 2000)` 回调在进程退出后不执行。但 worker 因 stdin EOF 自然退出，不影响正确性，仅 2 秒强杀宽限拿不到。

---

## 补充发现（2026-08-21 合并外部 review）

> 来源：另一路独立 review（3 并行子代理 + 主控逐条复核），聚焦 IPC/存储/前端边界。与本文 #1–#12 无重合（唯一重合项「reindex/downloadModel 缺并发守卫」已在「独有非阻断」列）。**#13/#14 为 P1，其余 P2/nit。**

### #13〔P1〕seedKbModel 部分拷贝恢复失效，模型永久损坏

**位置**：`src/main/storage/builtin.ts:113-116`

**现象**：`seedKbModel()` 首启把 ~23MB 模型从 `resources/kb-models` 复制到 `userData/kb-models`（`cpSync` 同步）。若中途崩溃（断电/OOM/强杀），dest 残留半截 `.onnx`。下次启动 `entries.some(e => e.endsWith('.onnx'))` 判定「已有模型」→ 跳过复制 → 半截模型永久留存，embed 报错且无法自愈（`downloadKbModel` 幂等跳过非空文件也救不回）。

**影响**：full 包用户首启崩溃后模型损坏，`kb:search` 向量路持续失败，无恢复路径。

**修复方向**：复制完成后写 `.complete` 标记文件，存在性判定改为「标记文件存在」；或校验 7 个文件齐全且非空。`downloadKbModel` 同理（写完成标记）。

### #14〔P1〕前端 onAdd/onPickFile/onRemove 失败静默

**位置**：`src/renderer/src/pages/KbPage.tsx`（`onAdd`/`onPickFile`/`onRemove`）+ `src/renderer/src/api/hooks.ts`（`useKbAdd`/`useKbPickFile`/`useKbRemove`）

**现象**：三个 mutation hook 均无 `onError`，`QueryClient` 也无全局兜底（`new QueryClient()` 无 defaultOptions）。`onAdd`/`onPickFile`/`onRemove` 无 try/catch → `mutateAsync()` reject 时成为 unhandled promise rejection，用户**零反馈**。`onPickFile` 最易触发（文件 >20MB → `errors:kb.file_too_large`、类型不支持、抽取失败）。

**影响**：摄取失败用户无感知，误以为成功。

**修复方向**：三个 handler 补 try/catch + `errorMessage(err, t)`，与 `onDownloadModel`/`onReindex`/`onSearch` 一致。

### #15〔P2〕download-model 流式落盘无大小上限

**位置**：`src/main/vector/download-model.ts:84`

**现象**：`pipeline(Readable.fromWeb(res.body), createWriteStream(dest))` 直写磁盘无 cap。已知模型 ~22MB 属正常，但服务器异常/重定向到超大文件时无防呆。与 #12（无重试）是不同维度。

**修复方向**：流式写入时累计字节数，超阈值（如 100MB）中止 + 删半截文件。

### #16〔P2〕v11 migration 非幂等

**位置**：`src/main/storage/db.ts:291`

**现象**：`ALTER TABLE kb_docs ADD COLUMN content TEXT;` 是全部 migration 中唯一非 `IF NOT EXISTS` 的 DDL。列已存在（dev 分支残留/手工改动）时抛「duplicate column name」，事务回滚（含 schema_version 登记）→ 每次启动重跑失败。

**修复方向**：迁移前查 `PRAGMA table_info(kb_docs)` 判列存在，或包 try/catch 幂等。

### #17〔P2〕onProviderChange 错误写进 searchError

**位置**：`src/renderer/src/pages/KbPage.tsx:152`

**现象**：provider 切换失败 `setSearchError(errorMessage(err, t))` → 错误显示在搜索区而非 provider 下拉旁，用户困惑。

**修复方向**：独立 providerError state（或复用 status bar 错误位）。

### #18〔P2〕useKbProviderPreference 死代码

**位置**：`src/renderer/src/api/hooks.ts:212-217`

**现象**：hook 导出但从未被任何组件 import；provider 下拉只读 `status.activeProviderId`。`useKbSetProviderPreference` 的 `invalidateQueries(['kb','providerPreference'])` 无对应消费者。

**修复方向**：删除 hook，或让 provider 下拉改读该 query（保持 status 为单一事实源亦可，删 hook 即可）。

### #19〔P2〕cancelReindex 不清 kb_reindex_required 标志

**位置**：`src/main/vector/reindex.ts:133-135`

**现象**：`cancelReindex()` 只 abort + 置 null，不清 `kb_reindex_required`。用户取消全量重嵌后 `kb:status` 持续 `reindexRequired=true`，前端一直提示 reindex。

**修复方向**：取消时清标志（或前端只在 reindex 进行中显示提示）。

### #20〔P2/nit〕checkVecDimDrift 只采样一行

**位置**：`src/main/vector/embed.ts:321`

**现象**：`SELECT DISTINCT vec_dim ... LIMIT 1` 只取一个任意向量维度。混合维度库（部分旧 384、部分新 1536）采样到「当前维度」时漂移漏检。

**修复方向**：取 `SELECT DISTINCT vec_dim` 全量，任一 ≠ 当前维度即标 reindex。

### #21〔nit〕kb:doc.removeConfirm 死 i18n key

**位置**：`src/renderer/public/locales/{zh-CN,en}/kb.json`

**现象**：`kb:doc.removeConfirm` 双语定义但从未被引用（实际用 `kb:removeConfirm`）。

**修复方向**：删除死 key。

---

## 补充发现 · 并行 review（2026-08-22 合并）

> 来源：另一路工作流并行 review（多子代理分模块 + 专门核验 fork），聚焦 worker 健壮性 / 死代码 / 检索融合边角。与本文 #1–#21 无重合。**无 P0；#22 为最需关注的 P2（健壮性会让检索热路径长期退化且自愈难）。**

### #22〔P2〕worker 批超时只 reject 不杀卡死 worker，检索热路径永久退化纯词法

**位置**：`src/main/vector/worker-client.ts:179-206`（超时分支）+ `:43`（ensureWorker 复用判定）+ `:90-99`（仅 close/error 触发 failAll）

**现象**：`setTimeout` 超时分支（line 180-184）只 `state.pending.delete(id)` + `reject(new Error('timeout'))`，**不 `killProcessGroup`、不置 `state.failed`**。卡死的 worker（ONNX `session.run` 真阻塞 / 进程活着但不响应）**永不触发 `close`/`error` 事件**——这两个才是现有 `failAll` → `worker=null` 重建的入口（line 90-99）。于是 `ensureWorker`（line 43 `if (worker && !worker.failed) return worker`）继续复用同一卡死进程。

**失败场景**：一次 embed 卡死 120s 超时后，worker.failed 仍为 false → 此后**每一次** embed（含 `kb:search` 的 query 向）都复用该卡死进程、都等满 `EMBED_TIMEOUT_MS=120s` 才降级 null → `search.ts` 检索热路径每查询被拖 120s 后纯词法兜底，**直到 app 重启**（重启后 `ensureWorker` 重建）。line 183 注释「届时由 close/fail 重建」在卡死场景不成立（卡死不触发 close/fail）。

**影响**：向量检索长期不可用且无告警，仅功能降级不崩——与降级链哲学一致，但用户体验劣化严重且无法自愈。

**修复方向**：超时分支补 `state.failed = true; killProcessGroup(state.child)`，强制下批重建 worker；并补「卡死 worker 自愈」单测（mock spawn 一个不响应的子进程，断言超时后下批 respawn）。

### #23〔P2〕abort 监听器 `{once:true}` 正常完成不移除，逐批累积

**位置**：`src/main/vector/worker-client.ts:186-191`

**现象**：`signal?.addEventListener('abort', onAbort, { once: true })` 注册在调用方（如单次 ingest 的 AbortSignal）上，但**正常完成（resolve，line 130-136）与超时（reject，line 179-184）路径都未 `removeEventListener`**；仅真实 abort 触发时才自动卸载。对长期存活的 signal（单次 ingest 含大量 batch），每完成一批就漏挂一个闭包监听器，随批数线性累积（内存 + 事件回调），batch 很多时泄漏明显。

**修复方向**：resolve/reject/timeout 三分支统一在 `finally` 里 `signal.removeEventListener('abort', onAbort)`。

### #24〔P2〕RemoteEmbeddingProvider embed 无超时上限

**位置**：`src/main/vector/embed.ts:163`

**现象**：本地路径有 worker 的 `EMBED_TIMEOUT_MS=120s`（worker-client.ts:17/179-184），但 `RemoteEmbeddingProvider.embed()` 的 `fetch(url, { signal })` 只透传调用方 AbortSignal，**无自身 `AbortController.timeout()`**。无 abort 信号传入时（如 `search.ts:66` `provider.embed([trimmed], undefined, 'query')` 未传 signal），黑洞/慢速 provider 会让 embed 无限挂起，阻塞 ingest / search，违背「阻塞绝不无限等」的降级链纪律。

**修复方向**：`embed()` 内包装 `AbortController.timeout(N)`（复用 EMBED_TIMEOUT_MS，或按 batch 大小动态），与本地 worker 对齐；超时返回全 null 降级。

### #25〔nit〕`kb_vec_dim` app_meta 死写 + `BGE_M3_DIM` 陈旧注释

**位置**：`src/main/storage/db.ts:470`（写）+ `:454`（注释）

**现象**：`setAppMeta('kb_vec_dim', String(dims[0]))` 写入后**全局无任何读取者**——`embed.ts:314-333` 的 `checkVecDimDrift()` 用新 SQL `SELECT DISTINCT vec_dim ... LIMIT 1` 自行探测，从不读此 app_meta key。且注释引用的 `BGE_M3_DIM` 符号在代码中**不存在**（embed.ts 实际导出的姊妹是 `KB_MODEL_DIM`）。属误导性死写/陈旧注释，读者会误以为维漂移检测依赖它。

**修复方向**：删除该写（或让 `checkVecDimDrift` 真正消费它以名实相符）；注释改指实际符号。

### #26〔P3〕FTS LIKE 兜底不按剩余配额截断，RRF 向词法倾斜

**位置**：`src/main/vector/kb-fts.ts:94-108`（被 search.ts:93 调）

**现象**：`if (ftsIds.length < topK)` 触发 LIKE 兜底，但 LIKE 查询自带 `LIMIT ?`(topK) 且追加时**只按已见 id 去重，不按剩余配额（topK - ftsIds.length）截断**。FTS 路已回 4 条、topK=5 时，LIKE 再回 5 条全新 id → FTS channel 最多 ~2×topK-1 条；而向量路严格 `topK` 条（search.ts:79）。R RF 中词法路 rank 更深、权重更多，**与"两路同 topK"设计前提不符**，融合向词法倾斜。

**修复方向**：LIKE 追加时按 `topK - ftsIds.length` 截断新增量（或直接把 FTS+LIKE 合并候选也 cap 到 topK）。

### #27〔nit〕原生文件对话框硬编码中文

**位置**：`src/main/ipc/knowledge.ts:109-113`

**现象**：`dialog.showOpenDialog({ title: '选择文档', filters: [{name:'文档'},{name:'所有文件'}] })` 主进程原生对话框硬编码中文。属系统原生 UI，非渲染层 JSX，不归 T2 严格约束；与既有 `skills.ts` 同范式，仅记录不做强改（若要本地化需走 dialog 的 locale 或接受现状）。

---

## 方法论反思（诚实记录）

本轮独立通读 + 两条 fork 核查抓到 4 条（#1 的注释误导迹象、#3、#7、#8 + 若干非阻断），但 **#1 的真正严重性、#2、#4、#5、#6、#9–#12 共 8 条是 code-review skill 的多角度 finder（line-by-line / removed-behavior / cross-file / reuse / simplification / efficiency / altitude / conventions）抓到而我漏掉的**。

漏报根因：
1. **降级链注释不可信**（#1）：`store.ts:129` 注释声称「下次 search 触发重载」，我读注释时信了，没追 `search()` 是否真调 `load()`。code-review 的 line-by-line finder 逐行验调用链才抓到。**教训：降级链的注释承诺必须追实际调用验证，不能信注释。**
2. **跨文件事务边界盲区**（#4）：`insertKbChunks` 和 `upsertKbDoc` 在不同文件、各自封装事务，我读 pipeline 时把它们当两个独立步骤扫过，没意识到「两个独立事务 = 崩溃窗口」。code-review 的 cross-file finder 专门追事务边界。
3. **远程响应长度假设**（#2）：我默认 OpenAI `/embeddings` 返回与 `input` 等长，没考虑 max-input 截断。code-review 的 removed-behavior finder 追「截断时尾部如何处理」。
4. **边界输入未构造**（#5）：未闭合 fence 是畸形输入，我没主动构造测试。code-review 的 altitude finder 追「不完整输入的边界行为」。
5. **并发去重模式**（#6）：init-promise 去重是标准模式，我看到 `if (!initialized) await init()` 时没意识到并发窗口。code-review 的 conventions finder 识别此反模式。

**结论**：单视角通读易漏降级链注释误导 + 跨文件事务 + 边界输入 + 并发去重。多角度 finder 互补。后续重大模块 review 应默认跑多角度 finder fan-out。

---

## 建议修复顺序

| 序 | # | 改动量 | 理由 |
|----|---|--------|------|
| 1 | #1 | 小（search 加 lazy load 或 invalidate 后 warm） | 最严重，新摄取文档搜不到，最常见路径 |
| 2 | #6 | 极小（init-promise 去重一行） | 防 OOM，一行改 |
| 3 | #2 | 小（补 null 到等长 + warn） | 一行级，防静默召回降级 |
| 4 | #13 | 小（.complete 标记文件） | P1，full 包首启崩溃后模型永久损坏 |
| 5 | #4 | 中（外层事务包裹，需 store 暴露事务内版本） | 防孤儿不可见 |
| 6 | #5 | 小（推进后 maxTokens 再校验 / 未闭合当普通文本） | 防 chunk 超长 |
| 7 | #14 | 小（三个 handler 补 try/catch + errorMessage） | P1，摄取失败用户零反馈 |
| 8 | #7 | 中（递归 list 或换 parser） | 污染分块质量 |
| 9 | #3 | 中（searchFlat 内置 docIds 过滤） | 触发概率低但语义该修 |
| 10 | #8 | 小（抽出 providerTag helper 共用） | 一行级口径统一 |
| 11 | #16 | 小（PRAGMA table_info 判列存在） | 防启动迁移失败循环 |
| 12 | #17/#18/#19/#20/#21 | 小（前端错误位 + 删死代码 + 清标志 + 全量采样 + 删死 key） | 一起做，均为小改 |
| 13 | #9-12 | 中（打包清理：hasLocalModel 缓存 + 抽 http helper + 复用 retry + 大小上限） | 一起做，避免反复动 extract/embed/download |
| 14 | #22 | 小（超时分支 killProcessGroup + 置 failed） | worker 卡死不自愈，检索热路径长期退化——并行 review 最高优先级 |
| 15 | #23 | 极小（resolve/reject/timeout 统一 remove abort 监听） | 长会话批量 ingest 内存累积 |
| 16 | #24 | 小（远程 embed 包 AbortController.timeout） | 防黑洞 provider 无限挂起，对齐本地超时 |
| 17 | #25 | 极小（删 kb_vec_dim 死写 + 改陈旧注释） | 防误导，一行 |
| 18 | #26 | 小（LIKE 追加按剩余配额截断） | 修 RRF 词法倾斜 |
| 19 | #27 | 可选（对话框本地化，可留现状） | 与既有范式一致，不强改 |

> 每条修完跑 `vitest src/main/vector` + `tsc --noEmit` 回归；#1/#3/#4/#5 需补对应测试（现有测试未覆盖「写入后即搜」/「限定 docIds」/「崩溃孤儿」/「未闭合 fence」）；#22 补「卡死 worker 自愈」单测。修完同步勾选本文 + 更新 `task.md` 缺口表。

---

## 修复落地（2026-08-21，按代码事实复核后执行）

**分级修正**：复核发现本文档 6 个 P0 中仅 **#1 是真阻塞**（且影响面比原文更大——不只「新摄取文档搜不到」，任何写入/删除后整个向量路静默失效直到重启）；#2/#4/#5/#6/#7 实为 P2 级防御缺口（有概率前提或仅边界输入触发）。两条诊断不准：

- **#19 诊断反转**：`cancelReindex()` 本身无需清标志——`runReindex` 收尾无条件 `setAppMeta('kb_reindex_required', '')`。**真实问题在另一侧**：全量重嵌 `clearAllKbVecs()` 后中途取消，旧向量已清、新向量未补完，标志却被清 + 进度发 `done` → UI 不再提示而全库 vec=NULL 长期裸奔。已修：取消时若已 clearAll 则保留标志，进度发新增 `cancelled` 类型（前端中性提示，非失败态）。
- **#20 无需改**：`db.ts` 启动时 `SELECT DISTINCT vec_dim` 全扫已覆盖多维度混存；`checkVecDimDrift` 的 LIMIT 1 单值比对是「库内维度 vs 当前 provider 维度」的另一层判定，职责不同。

**落地清单**（vitest 731 全绿 + tsc 干净，新增回归测试 14 条）：

| # | 落地 |
|---|------|
| #1 | `flat-index.search()` 入口惰性 `load()`（加载失败 degraded=true 走纯词法）；`store.ts` 注释契约兑现；回归测试「invalidate 后即搜命中」 |
| #3 | 非分片 `searchFlat` 支持 docIds 过滤（`docIdsFlat` 与 ids 对齐）；fetch 阶段裁剪保留作窗口期兜底 |
| #4 | `store.ts` 新增 `ingestKbDocument`（better-sqlite3 嵌套事务自动 savepoint），pipeline 改单事务；回滚测试（doc 约束失败 → 无孤儿 chunk） |
| #5 | 未闭合 fence 先探闭合行，找不到则当普通文本在 maxTokens 处硬切；测试覆盖 |
| #6 | worker `initPromise` 去重，并发 batch 共享一次模型加载 |
| #22 | 批超时 → `killProcessGroup` + 置 failed，下批重建（卡死自愈）；新 `worker-client.test.ts` 覆盖 |
| #23 | settledResolve/settledReject 包装，所有收尾路径摘除 abort 监听；测试覆盖 |
| #2 | 远程响应条数校验：短则补 null + warn，长则截断；测试覆盖 |
| #24 | 远程 embed 60s 自身超时（AbortController 链接调用方 signal）；测试覆盖 |
| #7 | `htmlToMarkdown` 列表改「最内层列表迭代替换」（tempered-greedy 正则，cap 20），嵌套/交叉嵌套测试覆盖 |
| #8 | `embed.ts` 新增 `providerTagFor()`，pipeline/reindex 同口径（remote→modelId，local→'local'） |
| #13 | 下载逐文件 `.part` + rename 原子化；seed 复制到临时目录再 rename，失败不拖垮启动（可运行时下载补齐）——未采用 .complete 标记方案，避免存量安装迁移问题 |
| #12 | 下载单文件 5xx/网络错误退避重试 3 次（未复用 `llm/retry.ts`——其 isRetryable 是 LLM SDK 错误形态，与裸 fetch 不同构，各自保持简单） |
| #15 | 单文件 200MB 流式上限，超限 destroy + 清 .part |
| #14 | KbPage onAdd/onPickFile/onFetchUrl/onRemove 全部 try/catch + 分区错误展示（抽屉内 / 文档网格上） |
| #17 | providerError 独立 state，不再写搜索框错误区 |
| #18 | 删 `useKbProviderPreference` 死 hook（下拉以 status.activeProviderId 为单一事实源） |
| #19 | 见上「诊断反转」 |
| #9 | `hasLocalModel` 探测缓存 + `invalidateLocalModelProbe()`，`kb:downloadModel` 完成后失效 |
| #16 | runMigrations 捕获 `duplicate column name` → 登记版本跳过（防启动死循环） |
| #21 | 删 `kb:doc.removeConfirm` 死 key（zh/en；实际用的是顶层 `kb:removeConfirm`） |
| #25 | 删 `kb_vec_dim` 死写 + 修正陈旧注释 |
| #26 | LIKE 兜底按剩余配额 `topK - ftsIds.length` 取，消除 RRF 词法倾斜 |
| #10/#11 | 新增 `util/net.ts`（fetchWithTimeout）+ `util/html.ts`（stripTags/decodeEntities 全量实体表），web.ts 与 extract.ts 同源 |
| #20 | 不改（见上） |
| #27 | 不改（与 skills.ts 既有模式一致，对话框标题本地化留待统一处理） |
