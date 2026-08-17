# One 代码审计裁决（2026-08-17）

> 本文核查 5 大类、24 个断言，全部基于逐文件读取真实代码（Read/Grep），非转述。每条给裁决、证据（file:line）、行号校正、后果判断。供后续修复逐条追溯。

> **修复状态（2026-08-17）：P0 全修、P1 全修、P2 全修、P3 全修。** 共 20 项闭环：
> - **P0-1** retry 重试 text/thinking 去重（编排链路补 onRetry 桥接 + reducer retry case + output/thinking resume）
> - **P0-2** 崩溃草稿灌回 UI（HomePage composer 自动回填 + EditorPage 画布 normalizeGraphToCanvas 复用 + CrashRecoveryDialog 恢复按钮导航）
> - **P1-1** sessions 事务化（removeSession 三 DELETE / addMessage INSERT+touch 同事务）
> - **P1-2** runMigrations 事务化（每条 migration DDL+版本登记同事务）
> - **P1-3** 启动备份 checkpoint（backupCurrentDb 先 wal_checkpoint(TRUNCATE)）
> - **P1-4** opencli 白名单（黑名单→基于 cli-manifest.json 的 (site,verb)→access 元组校验，自维护 + fail-closed）
> - **P1-5** registry abort 不重试（catch 内 signal.aborted 立即返回不重试）
> - **P1-6** opencli/skillScript detached（spawn detached:true + process.kill(-pid) 杀进程组，治孙进程孤儿）
> - **P2-9** openai-client tool_use id 一致性（延迟给 id 时挂起 + 补发 + 兜底合成 id）
> - **P2-10** reducer 按 speaker 查气泡（findStreamingBubbleForSpeaker 治 Concurrent 碎片化 + toolCall 误挂）
> - **P2-11** web searchBrave try/catch（5xx 返回 {ok:false} 让降级链继续）
> - **P2-12** HITL 两桥错误语义统一（ApprovalDecision 判别联合 + rejectionToApprovalReason + registry 分流 i18n key）
> - **P2-13** JSON I/O 异步化（决策：接受同步 fs 为设计缺口，记入 json-store.ts 顶部注释 + 留异步化路径）
> - **P2-14** memory 输入长度上限 + LIKE 转义（KEY/VALUE/QUERY_MAX + escapeLikePattern + ESCAPE '\'）
> - **P3-15** 删 addSwitchCaseEdgeGroup 死代码（builder + models + concurrent.test mock）
> - **P3-16** 删 WorkflowInput/PatternBuilder 死代码（models）
> - **P3-17** handler 按 retryable 分级日志（IpcErrorThrow/retryable→warn，其余→error）
> - **P3-18** 入口解析失败抛错非静默（resolveStartExecutor 回退分支 throw errors.graph.empty）
> - **P3-19** orchestrate abort 返回 stopReason（runWorkflow 返回带 stopReason，仅 converged 落 assistant 消息）
> - **P3-20** 模块级单例按 sessionId 隔离（activeRuns Map 替代 currentAbortController 单例，多窗口互不顶替）
>
> 全量 typecheck 干净；vitest 569 passed（新增 30 case：reducer retry 2 + toolCall speaker 2 / CrashRecoveryDialog restore 2 / opencli manifest 4 / registry abort 1 + approval 分流 3 / processKill 7 / sessionApprovals 7 / openai delayed-id 1 / l3 LIKE 转义 2 / runner abort stopReason 2，部分文件计数重叠）。P2/P3 详见文末优先级表（全部 ✅）。

## 审计方法

派 5 个核查子代理并行，每个负责一类，读到真实代码后回 `CONFIRMED / PARTIAL / REFUTED` + 证据片段 + 行号校正。覆盖文件：

- 流式并发：`src/main/llm/retry.ts`、`client.ts`、`openai-client.ts`、`src/main/orchestrator/agent.ts`、`src/renderer/src/store/reducer.ts`、`src/main/ipc/orchestrate.ts`、`runner.ts`、`home.ts`
- 崩溃草稿：`src/renderer/src/pages/HomePage.tsx`、`EditorPage.tsx`、`components/CrashRecoveryDialog.tsx`、`App.tsx`、`src/preload/index.ts`、`src/main/crash-recovery.ts`、`ipc/native.ts`
- 持久化：`src/main/storage/json-store.ts`、`sessions.ts`、`db.ts`、`ipc/models.ts`、`storage/models.ts`
- 工具安全：`src/main/tools/registry.ts`、`builtin/{opencli,skillScript,web,memory,shell}.ts`、`storage/memory/l3.ts`
- 画布：`src/main/orchestrator/builder.ts`、`ipc/orchestrate.ts`、`ipc/handler.ts`、`orchestrator/models.ts`

## 总览：19 CONFIRMED / 4 PARTIAL / 1 REFUTED

断言整体扎实——绝大多数有实锤代码支撑。但存在 **1 个机制描述错误**、**4 个程度/因果夸大**、**若干行号偏差**，需校正后才能作为修复依据。

---

## 一、流式/并发正确性（P0–P1）

### 断言 1.1：断网重试全量重放 + tool_use args 二次拼接 — PARTIAL（已修复）

> **复核修正**：初轮 subagent 把 home 主链路判为"翻倍实锤、用户可见"是**误判**——它只看了 `home.ts` 的 `onText` emit，漏读渲染层。`HomePage.tsx:261-281` 的 `retry` delta 分支**早已** `text:''`、`thinking:undefined` 清空同一气泡，且 `:254` 的 `last.streaming || last.retrying` 让重试后第二轮 text/thinking resume 到同一气泡续写（不翻倍）。即 home 主链路**本就正确**。真实缺陷只在**编排链路**：`patterns/agent.ts` callbacks 缺 `onRetry` 桥接 + `reducer.ts` 无 `retry` case → 重试后第二轮 output 事件在原累加文本上继续累加 → 翻倍。此为 P0-1，已修。

**证据链：**

- `src/main/llm/retry.ts:133-139` — `RetryingClient.stream` 在 catch 块命中 `isRetryable` 后用同一 `req` 重跑 `this.inner.stream(req)`，`req` 含同一 `onDelta` 回调，重试时**没有重建、没有包装去重**。
- `isRetryable`（`retry.ts:77-79`）匹配 `/network|fetch|abort|timeout|connection|econn|enotfound/i`，断网/超时命中重试。断言说 71-79 略宽——71-72 是"畸形 tool input JSON"分支也返回 true，不属本断言语境。
- `client.ts:90`（Anthropic 适配器 `handleStreamEvent`）对每个事件全程调 `onDelta`。
- `openai-client.ts:149-183` — OpenAI 适配器同理，`tool_use_start`/`tool_use_delta`/`tool_use_stop` 全程直接回调 `req.onDelta`。
- `agent.ts:117`/`agent.ts:237`（force_finalize 轮）— `emitDelta`（264-268）只对 text/thinking/message_stop 转发，**没有 tool_use_* 处理也没有幂等屏障**。

**后果：**

- **text/thinking 翻倍（已修复）**：home 主链路本就正确（`HomePage.tsx:261-281` retry delta 清空 + resume）。编排链路此前缺失 `onRetry` 桥接 + reducer retry case，重试后第二轮 `output`/`thinking` 事件在原累加文本上续累加 → 翻倍。**P0-1 已修**：`patterns/agent.ts` 补 `onRetry → ctx.add_event({type:'retry'})`，`reducer.ts` 加 `retry` case 清空同 speaker 末条 text/thinking 并置 retrying 态，`output`/`thinking` case 增加 `last.retrying` resume 分支（剥 retrying/retryInfo 续写同一气泡）。单测 `reducer.test.ts` 新增 2 case 覆盖（清空防翻倍 + 不同 speaker 不串）。
- **tool_use partial_json 二次拼接**：部分落地、部分潜在。openai 的 `toolCallMap` 是 `stream` 方法内局部变量，**每次 stream 调用都新建 Map**（`openai-client.ts:113`），不会在同一个 Map 上二次累加。但 `req.onDelta` 已把第一轮 partial_json 发给消费者——当前 main 进程无 tool_use delta 消费者（`agent.ts:emitDelta` 不转发 tool_use_*），故**当前未真正落地**。

**校正："唯一会静默产出错误数据的链路"过强。** text/thinking 翻倍仅编排链路实锤且已修；tool_use 二次拼接部分是潜在未落地。

**修复状态：✅ P0-1 已修**（编排链路补 onRetry 桥接 + reducer retry case + output/thinking resume；home 主链路本就无需改）。

### 断言 1.2：openai tool_call id 后补发 → 前后 id 不一致 — CONFIRMED

**证据（`openai-client.ts:160-183`）：**

```
:165  const id = tc.id ?? `call_${tc.index}`          // 首现用 tc.id 或合成 'call_'+index
:169  req.onDelta?.({ type:'tool_use_start', id, name })   // 用合成 id 下发 start
:171  req.onDelta?.({ type:'tool_use_delta', id, partial_json: args })  // delta 用合成 id
:176  if (tc.id) existing.id = tc.id                    // 后续补真 id 改 existing.id
:181  req.onDelta?.({ type:'tool_use_delta', id: existing.id, partial_json: argsChunk })  // delta 用已更新的 id
:209  req.onDelta?.({ type:'tool_use_stop', id: tc.id })  // stop 用真 id
```

**后果：** 消费者先收到 `tool_use_start{id:'call_0'}` + `tool_use_delta{id:'call_0'}`，然后收到 `tool_use_delta{id:'toolu_real'}`，最后 `tool_use_stop{id:'toolu_real'}`——start/delta 与 stop 的 id 不匹配 → 配对断裂。

**校正："已发生的坏数据链路"夸大。** 代码缺陷真实，但当前 main 进程无 tool_use delta 消费者，是**潜在 bug**，等前端接流式 toolCall 卡片渲染时爆。Anthropic 适配器（`client.ts:222-259`）用 `toolIds: Map<number,string>` 在 `content_block_start` 登记真 id（:225），后续查表用同一 id（:244、:259）——**没有此 bug**，OpenAI 是唯一有缺陷的。

**修复方向：** `openai-client.ts` 首现若无 `tc.id`，不发 start/delta，等真 id 到了再发；或用占位 id 但保证 stop 用同一占位 id。

### 断言 1.3：reducer 按末条气泡收束冻住并行 peer — REFUTED

**断言指控：** `reducer.ts:23/32/199/218/232/248` 全部只认 `prev[prev.length-1]`；`output` final 分支调 `closeStreaming(prev)`（30-42）停掉所有 stillStreaming 气泡。GroupChat/Concurrent 多发言并行时一方完成永久冻住另一方。

**实际代码：**

- `reducer.ts:23`（`output` case）取末条后**严格判 `last.speaker === ev.speaker`**（:26）。speaker 不匹配→走 else（:32-42）`closeStreaming` + 新建气泡。
- `closeStreaming`（`reducer.ts:267-274`）只把 `streaming:true` 改 `false`，**不丢文本**。被 close 的气泡文本保留完整。
- speaker 不匹配时**新建气泡**（碎片化），不是"永久冻住文本"。
- **GroupChat 严格串行不是并行**：`groupchat.ts:107-130` 每轮只定向请求一个 next_speaker（shouldRespond=true），其他 participant 是 broadcast（shouldRespond=false 仅 extend cache）。断言"GroupChat 多发言并行"不符合实际。
- **Concurrent 才并行**：`concurrent.ts:43-48` fan-out，runner 同 superstep 并发 deliver，多 participant 的 onText 交错推 output 事件。

**真 bug（机制需重述）：** Concurrent 并行流式时**气泡碎片化 + toolCall 丢失**——peer A 的后续 delta 到达时末条是 peer B，`last.speaker === 'A'` 为 false→else 分支又一次 closeStreaming + 新建 A 气泡，A 的文本被拆成多个气泡。`tool_call` case（:199）不匹配 speaker 时 `return prev`（:212）→ toolCall 信息丢失。GroupChat 不涉及。

**校正：行号全准确，但机制描述错误。** "冻住文本"实为"碎片化"；GroupChat 不涉及。

**修复方向：** reducer 的 `output`/`tool_call`/`tool_result` case 按 `ev.speaker` 查找对应气泡（而非只看末条），支持多并发流式气泡共存。

### 断言 1.4：编排 abort 被当成功返回 — PARTIAL

**证据：**

- `runner.ts:193-198` — abort 时 `stopReason='aborted'` + `onEvent({type:'failed',error:'aborted'})` + `return { output: ctx.output.join('\n') }`。**发了 failed 事件但没发 done**（正常路径 :305 发 done）。
- `orchestrate.ts:272-276` — handler 收到 `result.output` 直接 `addMessage` 存 DB + `return { runId, output }`，**不区分 abort**。IPC 返回类型 `{runId:string; output:string}`（:218）无 stop_reason。

**校正：**

- "取消的编排被当成功返回"——**IPC 返回值层面成立**：部分输出还被 addMessage 存入 DB。
- "渲染层无法识别取消 vs 正常"——**被夸大**：流事件能区分（abort 发 `failed`/正常发 `done`），reducer 对 `failed`（:74-94）和 `done`（:172-175）有不同处理。只是 IPC 同步返回值不带此信息。
- "对比 home.ts 有 stop_reason 判别"——**不精确**：home 正常路径有 `max_iterations`/`end_turn`（`home.ts:941-946`），但 abort 也走 catch throw error（:947-953），并非专门 abort stop_reason。

**修复方向：** `orchestrate:run` 返回值加 `stopReason` 字段，或 abort 时返回 `IpcFailure` 而非成功。

---

## 二、崩溃草稿闭环（P0）— 全 CONFIRMED（已修复）

> **修复状态：✅ P0-2 已修。** 三处灌回闭环：
> 1. **HomePage 挂载灌回 composer**：`HomePage.tsx` 新增 `[sessionId]` effect，`listDrafts()` 读 `home-composer.json`，校验 `kind`/`sessionId` 匹配后 `composerRef.insertText(text)` + `focus()`；仅当 composer 当前为空时灌回（防覆盖已开始的新输入）；ref 未就绪时 `requestAnimationFrame` 重试。
> 2. **EditorPage 挂载灌回画布**：`EditorPage.tsx` 提取 `normalizeGraphToCanvas(graph)`（原 capQ 加载 inline 的归一化管线），capQ.data 加载与新 `[capabilityId, capQ.data]` effect 共用同一函数；effect 读 `editor-${capabilityId}.json`，校验 `kind==='editor-graph'`/`capabilityId` 匹配后灌回 nodes/edges + 标 `restoredDraftAt`；画布底部 `Badge variant=warning` 显示 `editor:draftRestored`（保存即 removeDraft 清除）。
> 3. **CrashRecoveryDialog 加「恢复」按钮**：`draftRestorePath(name)` 解析 `home-composer.json→'/'`、`editor-{id}.json→'/capability/{id}'`；可恢复草稿显示 `crashRecovery.restore` 按钮，点击 `navigate(path)` 跳转目标页 → 页面挂载 effect 自动灌回。i18n key 加 `crashRecovery.restore` + `editor:draftRestored`（zh/en）。
> 主进程/preload 侧本就完整（`listDrafts`/`writeDraft`/`removeDraft`/`onCrashRecovery` 全白名单），无需新增 `readDraft`——`listDrafts` 已能按名读单条。单测：`CrashRecoveryDialog.test.tsx` 新增 2 case（restore 按钮仅可恢复草稿显示 + editor 草稿导航），原 10 case 用 `MemoryRouter` 包裹适配 `useNavigate`。

**结论：崩溃草稿恢复 UI 确实未闭环（已修复），此前只能复制 JSON 不能灌回。** 闭环的部分：哨兵检测→主进程推送+preload 缓存→CrashRecoveryDialog 列出草稿→HomePage/EditorPage debounce 写盘。此前**断在"灌回"这一环**，现已补齐（HomePage composer / EditorPage 画布 / Dialog 恢复按钮三路灌回）。

| 子断言 | 裁决 | 证据 | 校正 |
|--------|------|------|------|
| HomePage 写 home-composer.json | CONFIRMED | `HomePage.tsx:109-119`（断言 110-118 偏 1 行） | `.writeDraft({` 在 109 |
| EditorPage 写 editor-*.json（含 graph） | CONFIRMED | `EditorPage.tsx:394-405`（断言 396-404 偏 2 行） | content 在 397-403 |
| Dialog slice(0,500) 展示 | CONFIRMED | `CrashRecoveryDialog.tsx:107-108` | **行号张冠李戴**：断言说 slice 在 65-67，实际 65-67 是 `handleCopy`，slice 在 107 |
| clipboard.writeText 整个 JSON | CONFIRMED | `CrashRecoveryDialog.tsx:65-67` `handleCopy`→`navigator.clipboard.writeText(content)` | — |
| 只有复制按钮无恢复 | CONFIRMED | `CrashRecoveryDialog.tsx:89-103` 仅 `handleCopy`+`handleDismiss`，无 restore/recover/apply | — |
| preload 无 readDraft | CONFIRMED | `preload/index.ts` grep `readDraft` 0 hits；实现段 373-396（断言 373-414 略宽） | 有 listDrafts/writeDraft/removeDraft/onCrashRecovery |
| HomePage 挂载不回填 text | CONFIRMED | 7 个 useEffect（72/78/90/102/195/211/232）：102-123 是 2s 轮询**写盘**；211-229 重挂的是 create-* 确认卡（非 home-composer 草稿），且 `isComposerOrEditorDraft` 在 Dialog 侧显式排除 `create-` | 无任何代码读 home-composer.json 回灌 composerRef |
| EditorPage 挂载不回填 graph | CONFIRMED | 4 个 useEffect（226/245/335/367）：245-332 从 `capQ.data.graph`（远端已保存图）加载，非从 drafts/editor-*.json；367-419 是 800ms debounce 写盘 | 无任何代码读 editor-${capabilityId}.json 回灌 nodes/edges |

**主进程侧完整：** `src/main/crash-recovery.ts` 提供 markRunning/clearRunning/hadCrashedLastRun/listDrafts/writeDraft（临时文件+rename 原子写）/removeDraft；`src/main/ipc/native.ts:62/64/73` 注册 `app:listDrafts`/`app:writeDraft`/`app:removeDraft` 三个 withHandler；preload 全部白名单暴露（声明 207-213、实现 381-395）+启动早期缓存 `app:crashRecovery` 事件防丢（227-231）。

**措辞校正："文档与代码事实最大的脱节"偏激。** `task.md:136` 诚实标注 `[ ] 草稿写盘 + 渲染层订阅恢复 UI 未闭环`；`task.md:265` 2026-08-08 更新为"部分 ✅ …**仍缺**：输入框/画布一键自动灌回"；`CLAUDE.md` 写"草稿恢复 UI 未闭环"。**文档与代码一致，未闭环的是功能本身**，不是文档撒谎。

**修复方向：** preload 加 `readDraft(id)` 白名单 + Home/Editor 挂载 useEffect 读草稿回填 composerRef/nodes/edges；CrashRecoveryDialog 加"恢复到输入框/画布"按钮。

---

## 三、持久化/并发一致性（P1–P2）— 全 CONFIRMED

### 断言 3.1：主进程同步 JSON I/O 阻塞 — CONFIRMED

- `json-store.ts:30` `writeFileSync(tmp, JSON.stringify(data,null,2),'utf8')`
- `json-store.ts:38` `return JSON.parse(readFileSync(path,'utf8')) as T`
- 调用链：`ipc/models.ts:7-10` withHandler→ipcMain.handle→`storage/models.ts` `listModels`/`saveModel`（:92/104）→`modelsStore = new JsonSingleton`（:80）→`read()`/`write()`（:104/108）→同步 fs API。

**后果：** Electron 主进程单线程，同步 fs 阻塞期间所有 IPC + UI 卡死。原子写盘（临时文件带 pid+随机后缀 + rename）防并发互踩，没防阻塞。CLAUDE.md §11.4 只规定原子写盘，没规定异步 I/O——**设计层缺口**。

### 断言 3.2：多语句无事务留孤儿/错乱 — CONFIRMED

**`sessions.ts:62-68`（removeSession）：**
```
65  db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
66  db.prepare('DELETE FROM memory_l1 WHERE session_id = ?').run(id)
67  db.prepare('DELETE FROM memory_l2 WHERE session_id = ?').run(id)
```
三条 DELETE 各自 autocommit，未包 `db.transaction()`。memory_l1/l2 无外键（db.ts schema :60-72），崩在 65→66 之间留孤儿。

**`sessions.ts:90-97`（addMessage）：** INSERT（`.run` 在 :95）+ `touchSession`（UPDATE 在 :96）非同事务。崩中间→消息已入库但 sessions.updated_at 没更新，listSessions 按 updated_at DESC（:37）排序失真。

**校正：** "63-68"→实 65-67（63 是 `const db=getDb()`，68 是 `}`）；"90+97"→实 90-95 + 96（偏 ±1）。

**对比：** `l3.ts:163` 的 `removeL3` 用了 `db.transaction(...)`，skills/fts.ts:131/224 也用了事务，唯独 sessions 没用——不一致。

### 断言 3.3：迁移 v3 ALTER TABLE 非幂等且与 version 非原子 — CONFIRMED

**v3（`db.ts:101-105`）：** `ALTER TABLE sessions ADD COLUMN cwd TEXT`——`ALTER ADD COLUMN` 在 SQLite **非幂等**，重复执行报 `duplicate column name: cwd`。

**`runMigrations`（`db.ts:240-255`）：**
```
252  db.exec(m.sql)                    // ALTER 提交（autocommit）
253  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version)  // version 提交（另一 autocommit）
```
未用 `db.transaction()` 包裹。崩在 252→253 之间→schema 已加 cwd 列但 schema_version 无 v3→下次启动 `applied` 不含 3→重跑 ALTER→`duplicate column`→getDb 抛→启动失败或重建空库丢数据。

**修复极简：** `db.transaction(() => { db.exec(m.sql); db.prepare('INSERT...').run(m.version); })()`。

### 断言 3.4：启动备份未 checkpoint WAL — CONFIRMED

**启动备份 `backupCurrentDb`（`db.ts:189-198`）：**
```
193  copyFileSync(dbPath, getDbBackupPath())   // 只拷主库，无 checkpoint
```
无 `wal_checkpoint`。

**周期备份 `backupDatabase`（`db.ts:333-339`）：**
```
337  dbInstance.pragma('wal_checkpoint(TRUNCATE)')   // 先 checkpoint
338  copyFileSync(dbPath, getDbBackupPath())
```
有 checkpoint。启动调前者（`db.ts:290`），周期/退出调后者。

**后果：** WAL 模式下已提交写入可能滞留 `one.db-wal`，`copyFileSync` 只拷 `one.db` 不拷 -wal→.bak 缺最近写入→"假备份"。`recoverFromCorruption`（:219-237）从 .bak 恢复丢上次会话末尾数据。启动备份在 runMigrations 后立即做，migration 的 schema 变更可能还在 WAL→.bak 是"没应用 migration 的旧 schema + 旧数据"双重过时。注释（:331）自己写明"只拷主库会得假备份"，但启动备份没遵守。

**修复：** `backupCurrentDb` 改调 `backupDatabase`（或至少加一行 `db.pragma('wal_checkpoint(TRUNCATE)')`）。

---

## 四、工具/技能安全 — 4 CONFIRMED + 1 PARTIAL

### 断言 4.1：Abort 被当失败自动重试 3 次 — CONFIRMED

- `opencli.ts:81-84` / `skillScript.ts:67-69` — abort 时 `child.kill('SIGKILL')` + `reject(signal?.reason ?? new Error('aborted'))`，**无类型标记区分 abort 与真失败**。
- `opencli.ts:156-173` / `skillScript.ts:158-170` — catch 块只识别 ENOENT 和 stdout_limit_exceeded，其他（含 abort/timeout）一律 `throw e` 交回 registry。
- `registry.ts:194-216` — 重试层完全不区分 abort：`skipRetry = entry.def.approvalMode === 'always'`；opencli/skillScript 默认 `approvalMode='auto'`（registerTool 第 5 参数未传，:84 默认 'auto'）→skipRetry=false→maxAttempts=4→abort reject 后 sleep 500/1000/1500ms 重试 3 次。

**后果：** 已取消 spawn 副作用重复执行（opencli 已发浏览器请求/脚本已写文件，重试再发一次）。**shell.ts 免疫**：approvalMode='always'→skipRetry=true→maxAttempts=1 不重试。正确做法：catch 内 `if (ctx.signal?.aborted) return abortResult` 跳过重试。

### 断言 4.2：SIGKILL 只杀 direct child、不杀进程组 — CONFIRMED

- `opencli.ts:74` spawn **无 detached**；`:78/82/90` 全部 `child.kill('SIGKILL')`。
- `skillScript.ts:57-60` spawn 无 detached；`:64/68/76` 全部 `child.kill('SIGKILL')`。
- 对照 `shell.ts:45-50` `detached:true`（进程组 leader）+ `:65/76/89` `process.kill(-child.pid,'SIGKILL')`（杀整个进程组）。

**后果：** 孙进程逃逸孤儿（opencli 调的浏览器扩展桥、脚本 spawn 的 curl/ffmpeg/子脚本）继续跑，占用 CPU/内存/文件锁，timeout 后不停止。

**校正："占管道则父 close 永不触发 → stdout 上限失效"因果描述不精确。** `child.kill('SIGKILL')` 杀直接子进程，`child.on('close')` 在子进程死亡时**会触发**（不依赖孙进程）。真正失效的是：孙进程仍持有 stdout pipe 写端→父已 kill+reject 后 Promise 已 settle，后续 data 被丢弃；孙进程孤儿继续跑。核心缺陷（孙进程逃逸）实锤，"stdout 上限失效"机制偏移。

### 断言 4.3：opencli 写拦截是黑名单非白名单 — CONFIRMED

- `opencli.ts:22-30` `WRITE_VERBS` 是**动词黑名单集合**（~30 个动词）。
- `opencli.ts:141-148` 拦截逻辑：在 `cliArgs` 里找第一个命中 WRITE_VERBS 的 token，命中即拦，否则全放行。**精确 token 匹配**，args[0]（动词）和 args[1]（站点）都不做白名单校验。
- `opencli.ts:59` system fallback `return { cmd:'opencli', argsPrefix:[], env:process.env }` 无任何校验。

**3 类绕过例子：**
1. 新动词/未列入动词：opencli 100+ 站点动词空间开放。`args=["xiaohongshu","dm-send",...]`，`dm-send` 不在 WRITE_VERBS（只有 send/message-send/reply-dm）→放行→可替用户发私信。
2. 带参数变体：`--mode=publish` 等非精确 token。
3. system-PATH fallback（:59）：PATH 中的 opencli 是用户自装任意版本，动词集合可能与 WRITE_VERBS 不一致→新版动词放行。bundled 模式至少固定二进制版本，system 模式连版本都不控——断言"把任意 opencli当白名单"实锤（虽是"无校验"非"白名单"）。

**修复方向：** 改 `READ_VERBS` 白名单 + 站点白名单。

### 断言 4.4：web_search 5xx 降级落空 — PARTIAL

- `web.ts:39-41` `fetchText`：4xx 返回 `{ok:false,status}`，**5xx 直接 `throw new Error('http_'+res.status)'`**。
- `web.ts:108-128` `searchBrave` **无 try/catch**，5xx throw 冒泡。
- `web.ts:211-218` web_search handler：`await searchBrave` 5xx 时 throw→registry catch→重试 3 次全 5xx→返回错误 JSON。Jina/Bing 降级（:220-254）5xx 时全到不了。
- `web.ts:216-218` 空 if `if (brave.error !== 'no_key') {}` 体为空——死代码。

**校正：核心"5xx 降级落空"CONFIRMED。但"空 if 是降级落空根因"因果绑错。** 空 if 是独立死代码（4xx 时体为空无动作），5xx 落空根因是 `fetchText:41` 5xx throw + `searchBrave` 无 try/catch。两个独立缺陷被绑成一个。4xx 时 brave 返回 {ok:false}→跳过 return→执行 Jina（降级其实会发生）；5xx 时 throw 阻断。

**修复方向：** `searchBrave` 包 try/catch，5xx 时返回 `{ok:false,error:'brave_5xx'}` 而非 throw，让降级链继续。

### 断言 4.5：memory 工具同步 better-sqlite3 主线程 — CONFIRMED

- `db.ts:1,267` better-sqlite3 同步驱动，主进程无 worker_threads（grep 确认）。
- `l3.ts` 全部同步：`saveL3`(:64-78) 同步事务、`getL3`(:83-86) `.get()`、`listL3Keys`(:91-95) `.all()`、`searchL3`(:109-155) **4 个同步查询串行**（key LIKE + FTS MATCH + value LIKE + 回表 IN）、`removeL3`(:163-166) 同步事务。
- `memory.ts` handler 直接 `await getL3(...)`，但这些函数不是 async，`await` 同步值立即 resolve=同步执行。
- `memory.ts:75` `memory_retain.value` `z.string()` 无 max；`:53` `memory_search.query` 无 max。`split_atomicMemories`(:29-34) 只过滤 <4 字符碎片，不限制单条长度或总条数。

**补充缺陷（断言未提）：** `searchL3` LIKE 用 `%${query}%`（`l3.ts:134`）**未转义 %/_**，含 % 会变通配符全表扫描。FTS `buildMatchQuery` 对超长 query 生成大量 OR 项。`limit` 默认 5 只在最终 slice（:147）生效，中间 LIKE/FTS 可能扫全表。

**修复方向：** value/query 加 `z.string().max(N)`；LIKE 转义 %/_；考虑 l3 查询移到 worker_threads。

---

## 五、画布隐患（P2–P3）— 5 CONFIRMED + 1 PARTIAL

### 断言 5.1：addSwitchCaseEdgeGroup 死代码 + latent bug — CONFIRMED

- `builder.ts:53-55` `addSwitchCaseEdgeGroup` 用 `conditions.set(source, cases)` **整体覆盖**。
- `builder.ts:56-63` `addCondition` 用 `list.push` 追加。两者共享 `conditions: Map<string, Array<{predicate;target}>>`（声明在 :33）。
- 全库 Grep `addSwitchCaseEdgeGroup` 仅命中三处：`models.ts:67`（interface 声明）、`builder.ts:53`（实现）、`concurrent.test.ts:54,132`（测试 mock 空实现）。**无任何 pattern builder / 生产代码调用**——死代码。
- latent bug：若任一 pattern 先 `addCondition` 加 case 再 `addSwitchCaseEdgeGroup` 整体覆盖，前者加的条件边被静默丢弃。当前所有 pattern（sequential/concurrent/groupchat/handoff/magentic）都未调用它，故未触发。

**修复：** 删除 `addSwitchCaseEdgeGroup` 接口（`models.ts:67-70`）和实现（`builder.ts:53-55`）。

### 断言 5.2：入口解析异常回退空输出 — CONFIRMED

- `builder.ts:184-185`（`resolveStartExecutor` 内）：sequential 无有效 participant→回退 `graph.nodes.find(n=>n.type==='agent')?.id ?? node.id`。`node.id` 是 sequential 容器 id。容器不注册 executor（`builder.ts:131-134` 注释）。
- `runner.ts:227-231`：executor 找不到→`logger.warn('未找到 executor')`+跳过→pending 清空→:200 判定 converged→返回 `output:''`。
- `resolveStartExecutor` 未抛 `errors.graph.empty`（该校验在 `builder.ts:136-138` 的 `!startExecutor` 分支，此回退永远返回非空字符串绕过）。

**后果：** 前端无法区分"图空"与"解析失败"——空 output 与正常但无输出结果一致，渲染层无从触发错误提示。静默降级。**最严重隐患**。

**修复方向：** 回退分支抛 `errors.graph.empty` 或返回失败标记让前端区分。

### 断言 5.3：handler 对所有失败打 logger.error — CONFIRMED

- `handler.ts:21` 单行 `logger.error('[ipc:'+channel+']', error)`，无差别打 error 级。
- `isTransient`（:27-34）已区分瞬态/非瞬态塞进 `IpcResult.retryable`，但日志层未据此分级。
- 业务正常驳回（`IpcErrorThrow('errors.graph.cycle')` `builder.ts:38`、`errors.orchestrate.request_expired`）也走 error 级，污染错误统计。

**校正："噪声大"主观，但无差别 error 属实。** `orchestrate:cancel`（`orchestrate.ts:303-315`）正常取消不抛走 ok 分支；用户主动 cancel 不进 catch。

**修复方向：** 按 `error instanceof IpcErrorThrow` 或 `!retryable` 降级到 `logger.warn`。

### 断言 5.4：模块级单例多窗口互斥 — CONFIRMED

- 声明 `orchestrate.ts:41-43`（非断言 256-258，那是赋值行）：`let currentAbortController`/`let currentHitlRunId` 模块级 `let` 单例。
- 覆盖逻辑 `orchestrate.ts:250-255`：已有 run→abort 旧 controller + `rejectUserInputsForRun(prevRun,'aborted')`，然后覆盖。
- Electron 多 BrowserWindow 共享同一主进程模块实例→第二个 orchestrate:run 覆盖第一个的 controller。

**后果：** 已有"自动取消旧 run"防御，但前端第一个 run 只收到 abort 的 `failed:aborted` 事件，**与用户主动 cancel 不可区分**。`finally`（:282-285）`if (currentAbortController?.signal === signal)` 判不等→不清空，第一个 run 的 `skillProviders.afterRun()` 仍无条件执行——时序隐患，非崩溃级。

**修复方向：** abort 旧 run 时显式发"被新 run 顶替"事件让前端区分；或多窗口用 sessionId 隔离 controller。

### 断言 5.5：onAskUser vs onApprove 错误语义不一致 — CONFIRMED

- `orchestrate.ts:170-181` `onAskUser`：超时/取消时 `emitStream({type:'request_resolved',response:''})` + `throw e`（:180）——上抛。
- `orchestrate.ts:196-199` `onApprove`：超时/取消时 `emitStream({type:'approval_resolved',response:''})` + `return { approved:false, reason:'timeout or cancelled' }`——吞错返回。

**后果：** `onAskUser` 上抛符合铁律 11"工具调用失败返回错误 JSON 不抛"的精神但走 throw 路径（依赖 agent 侧 try/catch 转 JSON，未包好会死循环）；`onApprove` 吞错返回 false 不会死循环，但**丢失"超时"与"用户拒绝"区分**——reason 硬编码 'timeout or cancelled'，前端无法区分。

**修复方向：** 两者统一走 throw（让 agent tool-use 循环统一 try/catch 转 JSON），或两者都吞错返回 falsy 但带区分字段。

### 断言 5.6：models.ts 死代码 — PARTIAL

- `models.ts:49-52` `WorkflowInput` interface 全库无引用（`runner.ts:159-164` input 参数是内联 `{text:string;sessionId?:string}`，orchestrate.ts:272 调用也没用该类型）——死代码。
- `models.ts:55-59` `PatternBuilder` type 全库无引用（各 pattern builder 签名各自内联参数类型）——死代码。
- 其他 3 个 export 在用：`Executor`（runner.ts:7/builder.ts:4/patterns/*）、`RuntimeWorkflow`（runner.ts:7/builder.ts:30）、`BuilderContext`（builder.ts:4,41,233/patterns/*）。

**校正："大量死代码"夸大。** 5 个 export 中 2 个死代码（约 11 行），3 个核心在用。

**修复：** 删 `WorkflowInput`、`PatternBuilder`。

---

## 六、需要纠正的 6 处过度声称

1. **断言 1.3"reducer 冻住并行 peer"——机制错误（REFUTED）。** 真 bug 是 Concurrent 并行流式时**气泡碎片化 + toolCall 丢失**，不是"永久冻住文本"；GroupChat 严格串行不涉及。
2. **断言 1.1"唯一会静默产出错误数据的链路"——过强（且初轮误判 home 主链路）。** 复核发现 home 主链路本就正确（`HomePage.tsx:261-281` 已清空 + resume），仅编排链路翻倍且已修（P0-1）；tool_use partial_json 二次拼接是潜在未落地（当前无 delta 消费者）。
3. **断言 1.2"已发生的坏数据链路"——夸大。** 代码缺陷真实，但当前无消费者，是潜在 bug。
4. **断言 2"文档与代码事实最大的脱节"——偏激。** task.md 已诚实标注未闭环，文档与代码一致，未闭环的是功能本身。
5. **断言 4.4"空 if 是降级落空根因"——因果绑错。** 空 if 是独立死代码，5xx 落空根因是 fetchText throw + searchBrave 无 try/catch。
6. **断言 5.6"大量死代码"——夸大。** 2/5 死代码，3/5 在用。

---

## 七、修复优先级建议（按实锤严重度）

### P0（用户可见数据错误 + 优先缺口）

1. ~~**断网重试 text/thinking 翻倍**（断言 1.1）——✅ 已修（P0-1）**。复核：home 主链路本就正确（`HomePage.tsx:261-281` 已清空 + resume），仅编排链路翻倍。修复：`patterns/agent.ts` 补 `onRetry` 桥接 + `reducer.ts` 加 `retry` case 清空 + `output`/`thinking` resume 到 retrying 气泡；单测 2 case 覆盖。修复方向从"`retry.ts` 包装去重"改为"消费侧 `retry` 事件清空"——因为 `retry.ts:152` 已有 `req.onRetry?.()` 通知机制，重试通知本就该走它而非污染 onDelta。
2. ~~**崩溃草稿灌回 UI**（断言 2）——✅ 已修（P0-2）~~。HomePage 挂载 effect 读 `home-composer.json` 灌回 composer；EditorPage 提取 `normalizeGraphToCanvas` + 挂载 effect 读 `editor-*.json` 灌回画布 + `draftRestored` Badge 提示；CrashRecoveryDialog 加「恢复」按钮 `navigate` 到目标页触发自动灌回。i18n key `crashRecovery.restore`/`editor:draftRestored` 齐。单测 2 新 case + 原 10 case 包 `MemoryRouter`。无需新增 `readDraft` 白名单（`listDrafts` 已覆盖）。

### P1（崩溃恢复 + 安全边界）

3. ~~**sessions 加 `db.transaction`**（断言 3.2）——✅ 已修（P1-1）**。removeSession 三 DELETE 包 `db.transaction()`；addMessage INSERT + touchSession 内联 UPDATE 包同一事务（防「消息入库但 updated_at 未更新」列表沉底）；顺带删掉无外部调用方的 dead 导出 `touchSession`。
4. ~~**runMigrations 事务化**（断言 3.3）——✅ 已修（P1-2）**。每条 migration 的 `db.exec(m.sql)` + `INSERT schema_version` 包 `db.transaction(()=>{...})()`，防中途崩溃留半截 schema + 版本未登记导致下次重跑 CREATE 报 duplicate column。迁移单测 5 case 全过。
5. ~~**启动备份 checkpoint**（断言 3.4）——✅ 已修（P1-3）**。`backupCurrentDb(db)` 接收连接句柄，先 `db.pragma('wal_checkpoint(TRUNCATE)')` 再 `copyFileSync`——对齐周期 `backupDatabase` 语义，防 WAL 模式下 migration 写入未 checkpoint 导致启动备份拷到缺数据的「假备份」。storage 单测 61 全过。
6. ~~**opencli 改白名单**（断言 4.3）——✅ 已修（P1-4）**。从静态 `WRITE_VERBS` 黑名单改为基于 `cli-manifest.json` 的 `(site,verb)→access` 元组级校验：manifest 标 `read` 放行、`write` 或未知 fail-closed 拒绝。关键洞察：同名动词在不同 site 下 access 不同（bilibili/download:read vs suno/download:write），必须元组判定。manifest 随 vendor 更新自同步（零维护，新站点 read 自动放行）。manifest 缺失时降级 `WRITE_VERBS_FALLBACK` 黑名单。单测 4 新 case（元组分流/未知 fail-closed/list 全局放行）+ 原 7 case 全过。
7. ~~**registry catch 区分 abort**（断言 4.1）——✅ 已修（P1-5）**。`executeTool` catch 块加 `if (ctx.signal?.aborted) return {error:'aborted',...}` 立即返回不重试——abort 后重试只会把已废弃操作再跑 N 次（带退避延迟），延长取消响应、浪费配额。单测 1 新 case（abort 只调 1 次 handler）+ 原 23 case 全过。
8. ~~**opencli/skillScript 用 detached + kill(-pid)**（断言 4.2）——✅ 已修（P1-6）**。新增 `tools/processKill.ts` 的 `killProcessGroup(child)`：`process.kill(-pid, sig)` 杀整个进程组 + `child.kill` 兜底。两处 spawn 加 `detached:true` 使子进程成新进程组组长（其 pid 即 pgid）。治 opencli 起 Chrome、Python 脚本 shell-out 的孙进程在超时/abort 后变孤儿继续跑的泄漏。`processKill.test.ts` 7 case（负 pid 信号/无 pid 降级/ESRCH 静默/EPERM 降级/默认 SIGKILL/SIGTERM 优雅）+ 原 opencli/skillScript 19 case 全过。

### P2（潜在 bug + 一致性）

9. ~~**openai-client id 一致性**（断言 1.2）——✅ 已修**。`toolCallMap` entry 加 `started` 标记：首现无 `tc.id` 时挂起（记 name/args 但不发 start/delta），真 id 到后续 chunk 才补发 start + 全部累积 args；真 id 全程未到则用合成 id 兜底（聚合阶段补发 start 配对 stop）。全程 `tool_use_start`/`delta`/`stop` 用同一 id。单测 1 新 case（延迟给 id）+ 原 13 case 全过。
10. ~~**reducer 按 speaker 查气泡**（断言 1.3）——✅ 已修**。新增 `findStreamingBubbleForSpeaker(prev, speaker)` 从末尾往前找该 speaker 的 streaming/retrying 气泡；`output`/`thinking`/`retry`/`tool_call`/`tool_result` 改用它续写同一 speaker 气泡（治 Concurrent 碎片化 + toolCall 跨 speaker 误挂）。`node_started`/`node_done`/`node_error` 保留末条气泡逻辑（其 node_id 是子执行器但事件在父/聚合器上下文发出，按父气泡归属——否则并发聚合器场景断）。诚实 scoping：closeStreaming-on-new-bubble（已测设计）使真·并发流式多气泡共存超出当前 reducer 架构；修复保证 toolCall 不误挂别的 speaker 气泡（防错挂优先于防丢失）。单测 2 新 case + 原 29 全过（31/31）。
11. ~~**web searchBrave 包 try/catch**（断言 4.4）——✅ 已修**。`searchBrave` body 包 try/catch：5xx/网络错 `logger.warn` + 返回 `{ok:false, error:'brave_'+msg, messageKey:'errors.tools.search_failed'}` 让降级链（Jina/Bing）继续，不再 throw 到 registry 重试 3 次堵死降级。空 if 死代码改 `logger.info('[web] Brave 失败（…），降级到 Jina')`。单测 1 新 case（Brave 503 不重试直接降级 Bing）+ 原 8 全过。
12. ~~**HITL 两桥错误语义统一**（断言 5.5）——✅ 已修**。统一走「吞错返回 falsy 带区分字段」（对齐铁律11 不抛 → 不死循环）：`ApprovalDecision` 判别联合 + `rejectionToApprovalReason(err)` 把 `user_input_timeout`/`aborted`/其它映射成 `'timeout'|'aborted'`；三处 onApprove catch（orchestrate + home×2）从硬编码 `'timeout or cancelled'` 改为 `rejectionToApprovalReason(e)`；`registry.ts` 闸门按 reason 分流 i18n key（`approval_timeout`/`approval_aborted`/`approval_denied`）。onAskUser 已正确（askUser.ts try/catch 转错误 JSON 带 `e.message` 区分，保持）。新增 `errors.tools.approval_aborted` i18n（zh-CN/en）。单测 10 新 case（registry 3 + sessionApprovals 7）+ 原 31 全过（41/41）。
13. ~~**JSON I/O 异步化**（断言 3.1）——✅ 已决（接受为设计缺口）**。审计自判「设计层缺口」非 bug：本存储承载配置类小 JSON（capability/agent/skill/model/persona，单文件 < 数十 KB），同步 fs 在 SSD 亚毫秒级，不构成可感知卡顿。CLAUDE.md §11.4 只规定原子写盘，未要求 I/O 异步化。全面异步化需串联 models.ts（~20 方法）+ 18 个 IPC/工具调用方 ~80 处 await，回归风险远大于亚毫秒级缺口收益。决策记入 `json-store.ts` 顶部注释 + 保留异步化路径（若将来 skill 包内联文本膨胀到 MB 级再改）。
14. ~~**memory 输入长度上限 + LIKE 转义**（断言 4.5）——✅ 已修**。`memory.ts` 加 `KEY_MAX=200`/`VALUE_MAX=8000`/`QUERY_MAX=500` 长度上限（zod `.max()`）。`l3.ts` 加 `escapeLikePattern()` 把 `%`/`_`/`\` 转义，三处 LIKE 查询加 `ESCAPE '\'` 子句（key 前缀 / value LIKE ×2）。单测 2 新 case（`%`/`_` 字面匹配不误当通配符）+ 原全过。

### P3（清理）

15. ~~**删 addSwitchCaseEdgeGroup**（断言 5.1）——✅ 已修**。`builder.ts` 的 `bctx` 删 `addSwitchCaseEdgeGroup` 方法；`models.ts` 的 `BuilderContext` 接口删该成员（保留 `addExecutor`/`addEdge`/`addCondition`）；`concurrent.test.ts` 两处 mock 删该桩。无实现引用，纯死代码（switch-case 边组从未接入 Pregel runner）。
16. ~~**删 WorkflowInput/PatternBuilder**（断言 5.6）——✅ 已修**。`models.ts` 删 `WorkflowInput` interface + `PatternBuilder` type（全库无引用，runner.ts input 参数内联、各 pattern builder 签名各自内联）。保留在用的 `Executor`/`RuntimeWorkflow`/`BuilderContext`。
17. ~~**handler 按 retryable 分级日志**（断言 5.3）——✅ 已修**。`handler.ts` catch 块：`IpcErrorThrow` 或 `retryable` → `logger.warn`（业务正常驳回如 `errors.graph.cycle` 不再污染 error 统计）；其余 → `logger.error`。
18. ~~**入口解析失败抛错非静默**（断言 5.2）——✅ 已修**。`builder.ts` `resolveStartExecutor` sequential 无有效 participant 的回退分支从「静默返回首个 agent 节点」改为 `throw new IpcErrorThrow('errors.graph.empty')`——防「图空」与「解析失败」不可区分的静默降级。单测改 expect throw（`IpcErrorThrow` + `'errors:graph.empty'`）。
19. ~~**orchestrate abort 返回值带 stopReason**（断言 1.4）——✅ 已修**。`runWorkflow` 返回值加 `stopReason: 'converged'|'max_supersteps'|'aborted'`（abort 路径显式返回 `'aborted'`，不再混入 converged）；`orchestrate:run` 仅 `stopReason==='converged'` 时落 assistant 消息（abort/max_supersteps 不存半截输出）；`withHandler` 泛型 + preload 返回类型同步带 `stopReason`。单测 2 新 case（abort 立即返回 aborted+不发 done / 正常收敛发 done）+ 原 10 全过（12/12）。
20. ~~**模块级单例按 sessionId 隔离**（断言 5.4）——✅ 已修**。`orchestrate.ts` 模块级单例 `currentAbortController`/`currentHitlRunId` → `activeRuns: Map<sessionId, {controller, hitlRunId}>`，按 sessionId 隔离（无 sessionId 用 `__transient` 哨兵）。多 BrowserWindow 各持独立会话互不顶替；`finally` 按 `=== controller` 精确清自己的 entry（防被新 run 顶替后误删）；`orchestrate:cancel` 接受 `{sessionId?}` 精确取消该会话运行（向后兼容：无参取消临时运行）。preload + EditorPage `onStop` 传 `activeRunSid`。
