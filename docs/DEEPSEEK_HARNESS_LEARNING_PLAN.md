# One 向 deepseek-harness 学习的改造清单

## 目的

本文基于两个代码库当前实现事实，对比 `one` 与 `deepseek-harness` 的架构差异，整理 `one` 值得吸收的能力点，并给出具体改造方向、实施落点与预期收益。

本文不是泛泛而谈的“架构升级愿景”，而是围绕以下问题展开：

1. `deepseek-harness` 哪些底层能力明显强于 `one`
2. 这些能力在 `one` 当前代码里对应的短板是什么
3. 如果要改，应该改到哪些模块
4. 改完能带来什么核心能力提升

## 范围与事实依据

### One 当前事实

- `one` 是单应用仓库，主进程集中承载 IPC、编排、工具、技能、存储、桌面集成。[`CLAUDE.md`](../CLAUDE.md)
- 编排核心是自研 Pregel 风格 workflow runner，强调 `sequential / concurrent / groupchat / handoff` 图执行语义。[`src/main/orchestrator/runner.ts`](../src/main/orchestrator/runner.ts)
- 首页主 Agent 入口集中在 [`src/main/ipc/home.ts`](../src/main/ipc/home.ts)，会话运行态通过 `activeRuns<sessionId, ...>` 在进程内维护。
- 工具体系目前集中在 [`src/main/tools/registry.ts`](../src/main/tools/registry.ts)，已有 `preCheck`、`approvalMode`、重试、Zod 校验，但还是单注册表式实现。
- Skill 注入通过 [`src/main/skills/provider.ts`](../src/main/skills/provider.ts) 的 `beforeRun/afterRun` 完成，当前主要是 instructions 注入与简单审计日志。
- 持久化核心仍是业务表 + 配置文件模式，SQLite 中主要是 `sessions/messages/tasks/memory/topics/reviews` 等表。[`src/main/storage/db.ts`](../src/main/storage/db.ts)

### deepseek-harness 当前事实

- `deepseek-harness` 是大规模 monorepo，`packages/*/*` 下按能力域拆分，仓库明确遵循 “everything is a plugin”。[`/Users/shijianzhong/sking/deepseek-harness/AGENTS.md`](file:///Users/shijianzhong/sking/deepseek-harness/AGENTS.md#L1-L55)
- 其架构文档明确把 `session / system-prompt / tools / agent / agent-loop` 都定义成可替换的核心运行时部件。[`/Users/shijianzhong/sking/deepseek-harness/docs/architecture.md`](file:///Users/shijianzhong/sking/deepseek-harness/docs/architecture.md#L39-L61)
- 会话采用 append-only 事件日志模型，模型可见内容必须可由 session log 重建。[`/Users/shijianzhong/sking/deepseek-harness/docs/architecture.md`](file:///Users/shijianzhong/sking/deepseek-harness/docs/architecture.md#L92-L97)
- 工具执行不是单函数调用，而是带有 `pre-execute / execute / post-execute / result / change` 的统一执行管线。[`/Users/shijianzhong/sking/deepseek-harness/packages/core/tools/src/index.ts`](file:///Users/shijianzhong/sking/deepseek-harness/packages/core/tools/src/index.ts#L142-L208)
- Approval 和 ask-user 都是独立 capability seam，并且带 durable audit / policy / root-agent 限制语义。[`user-approval`](file:///Users/shijianzhong/sking/deepseek-harness/packages/interaction/user-approval/src/index.ts#L34-L72)、[`user-questions`](file:///Users/shijianzhong/sking/deepseek-harness/packages/interaction/user-questions/src/index.ts#L77-L140)
- 测试门禁非常重，除了 unit，还有 coverage gate、snapshot、web snapshot、artifact smoke、doc-sync、invariant 验证。[`testing.md`](file:///Users/shijianzhong/sking/deepseek-harness/docs/testing.md#L7-L49)、[`package.json`](file:///Users/shijianzhong/sking/deepseek-harness/package.json#L19-L142)

## 总判断

`one` 的优势在于桌面产品闭环、可视化编排、Electron 集成和交付效率；  
`deepseek-harness` 的优势在于运行时抽象、可观测性、可替换能力、测试纪律。

因此，`one` 不应该照搬 `deepseek-harness` 的 monorepo 规模和全插件化程度，但很值得吸收它在以下 5 个方向上的工程方法。

---

## Review 结论（2026-08-17 逐条核对代码后追加）

本节为对下文改造清单的 review 结果。review 方法：逐文件读取 `src/main/ipc/home.ts`、`src/main/storage/db.ts`、`src/main/tools/registry.ts`、`src/main/tools/sessionApprovals.ts`、`src/main/orchestrator/runner.ts`、`src/main/skills/provider.ts`、`src/main/crash-recovery.ts`，核对原文声称的“当前事实”。

### 事实核查结论

原文“范围与事实依据”列出的 One 当前事实，逐条核对结果属实，无硬伤：

- “主进程集中承载 IPC/编排/工具/技能/存储”——属实，`src/main/` 目录结构印证。
- “Pregel runner 四模式”——属实，`runner.ts:14-17` 注释明确“N emit / N+1 deliver”，`patterns/` 下有 sequential/concurrent/groupchat/handoff。
- “首页入口集中在 home.ts，运行态 `activeRuns<sessionId,...>` 进程内维护”——属实，`home.ts:87` `activeRuns = new Map<string, {controller, hitlRunId}>()`。
- “工具体系集中在 registry.ts，已有 preCheck/approvalMode/重试/Zod”——属实，`registry.ts:104` `executeTool` 有 preCheck→approval 闸门→重试三段。
- “Skill 注入通过 provider.ts 的 beforeRun/afterRun，主要是 instructions 注入与简单审计日志”——属实，`provider.ts:87` 拼 `<skill>` XML + discipline，`:118` afterRun 只打一行 logger.info。
- “持久化是业务表+配置文件，SQLite 中主要是 sessions/messages/tasks/memory/topics/reviews”——属实，`db.ts:20-186` MIGRATIONS 列了这些表。

### 需要修订的 8 点（详见各章节 Review 块）

1. **行动顺序**：第一阶段第 1 项应为“先闭环已有崩溃草稿恢复，再叠加 run_events”，而非从零搭 run_events。
2. **工具管线现状描述**：审批/策略/重试三层已有，缺的是从 if 分支提成可注册中间件链，非从零搭建。
3. **HITL durable 范围**：approval_requests/user_questions 要补；propose 草稿已有持久化可作模板，不重复造。
4. **run_events 事件范围**：先只覆盖原文点名的 5 个诊断问题，不一开头铺 20+ 事件。
5. **测试门禁升 P0**：与 P0 三件事并列。snapshot + 真调 smoke 是当前完全看不见的盲区。
6. **子运行提问边界**：依赖 run 父子层级先建，不能与 HITL domain 并列独立。
7. **compaction 连带成本**：若 event log 落地，compaction 需配套事务化。
8. **audit 去重**：audit 从“阶段”改为“result 阶段的 listener”，避免与 run_events 审计重复。

---

## P0：引入“运行时事实流”，把主 Agent / 能力 / 工具 / HITL 变成可回放事实

### 当前差距

`one` 现在的运行可观测性主要来自三类信息：

1. 前端流事件，如 `home:stream` / orchestrate stream
2. 主进程日志，如 `runner.start`、`runner.superstep`
3. 持久化后的业务结果，如 messages / tasks / drafts

这套机制能看“结果”，但不够擅长回答以下问题：

- 本次首页到底是直答还是转 team 了
- 命中了哪个 capability / skill / tool allowlist
- 为什么某个节点没跑，只是 cache extend
- 某个审批为什么弹了，是否命中过会话放行
- 某个 ask_user 是哪个节点、哪次 tool call 触发的

`deepseek-harness` 这里更强，是因为它把“模型可见”和“运行时关键事实”都纳入 session log / event 系统。

### 具体改造

建议在 `one` 里新增一层轻量级 `run_events` 体系，不需要一步到位照搬全部 event-sourcing，只要先覆盖关键运行事实。

建议改动：

1. 在 SQLite 增加 `runs` / `run_events` 两张表
   - `runs`: `id`, `session_id`, `entry`, `status`, `started_at`, `ended_at`
   - `run_events`: `id`, `run_id`, `session_id`, `seq`, `type`, `payload`, `created_at`

2. 在以下入口追加事实事件
   - `src/main/ipc/home.ts`
     - `home.run.started`
     - `home.route.decided`
     - `home.team.started`
     - `home.run.completed`
   - `src/main/orchestrator/runner.ts`
     - `node.scheduled`
     - `node.cache_extended`
     - `node.started`
     - `node.completed`
     - `node.failed`
   - `src/main/tools/registry.ts`
     - `tool.prechecked`
     - `tool.approval.requested`
     - `tool.approval.decided`
     - `tool.started`
     - `tool.completed`
     - `tool.failed`
   - `src/main/skills/provider.ts`
     - `skill.injected`
     - `skill.script_listed`
     - `skill.after_run`

3. 补一个 `run diagnostics` 查询层
   - 可先做主进程 query 函数 + IPC
   - 前端先不做复杂 UI，先支持按 runId 导出和查看时间线

### 核心能力提升

- 能精确解释“为什么这个节点停了 / 没跑 / 又弹审批了”
- 能把日志分析从“猜过程”变成“查事实”
- 为崩溃恢复、回放、问题归档、自动化 review 打基础
- 后续做 transcript snapshot、运行时对账会简单很多

### Review 修订（2026-08-17，依据代码核对）

**修订 1：行动顺序应前置“先闭环已有崩溃草稿恢复”。**

依据：`src/main/crash-recovery.ts` 已实现 `.running` 哨兵文件、`listDrafts`、`hadCrashedLastRun`；`src/main/ipc/home.ts:112` `hydrateCreateDraftsFromDisk()` 启动时已从 `drafts/` 水合未确认创建卡，`home.ts:102` `persistCreateDraft` 已同步落盘。CLAUDE.md 也把“崩溃草稿：哨兵/listDrafts 有，编辑器/聊天写盘 + 渲染层恢复 UI 未接”列为第 1 优先缺口。

结论：One 不是从零搭事实流，而是已有半成品。缺口在 UI 闭环和写盘点，不在基础设施。因此第一阶段第 1 项应改为“**先闭环已有崩溃草稿恢复（哨兵已就位，补聊天/编辑器写盘 + 渲染层恢复 UI），再在其上叠加 run_events 事实流**”。run_events 是草稿恢复骨架之上的增强，不是替代。跳过半成品直接搭 run_events，会让两套“运行态恢复”并存且语义打架。

**修订 2：run_events 表设计补一个对齐点。**

依据：`src/main/storage/db.ts:24` `sessions` 表已有 `capability_id` 列。`src/main/ipc/home.ts:325-334` 首页三分支 `focusCap`/`directAgent`/主Agent路由 是同一次会话里可能多次切换的 run（先直答再转组队）。run 与 session 不是 1:1。

结论：`runs.entry` 字段（直答/team/directAgent）有真实价值，正好对应 home.ts 三分支，保留。表设计本身合理。

**修订 3：run_events 事件范围应先窄后宽。**

依据：dsh 的教训是事件一旦写了就是“模型可见 ⟺ logged”硬约束，写少了不够、写多了维护重。原文列了 `tool.prechecked`/`tool.approval.requested`/`node.cache_extended` 等 20+ 事件类型。

结论：**先只覆盖原文“核心能力提升”点名的 5 个诊断问题**（本次直答还是转 team / 命中哪个 capability-skill-allowlist / 为什么某节点没跑只是 cache extend / 某审批为什么弹了是否命中会话放行 / 某 ask_user 哪个节点哪次 tool call 触发），不一开头就铺全部 20+ 事件类型。先跑起来再加。

**修订 4：补 compaction 连带成本一句。**

依据：CLAUDE.md 决策基线写“compaction_strategy/tokenizer 先用简单截断（MVP 跳过）”；`src/main/orchestrator/runner.ts:334-355` 现用条数截断 + token 截断。dsh 的 append-only event log 模型里 compaction 是事务式（`compaction/start`+`compaction/end` 包裹区间替换成 summary 节点）。⚠️ 按 2026-08-17 产品标准基线（不以 MVP 视角迭代），CLAUDE.md 这条「简单截断」决策应重估：硬截断会静默丢信息，对可上市产品不可接受，最终形态应为摘要式 compaction + spill（见「补充对齐点」节第 1 项），简单截断仅作为阶段性中间态、须有明确升级路径。

结论：若 run_events 未来演进到 append-only event log（而非仅追加事件表），简单截断会破坏 log 一致性，必须配套升级为事务式 compaction。原文未提这个连带成本，应补：“**若 event log 落地，compaction 需配套事务化（start/end 包裹），否则 log 压缩到一半崩溃会不一致**。”

---

## P0：把 Approval / ask_user 从 callback 桥升级为一等 domain

### 当前差距

`one` 现在的 HITL 能力已经能用，但主要是运行时注入桥：

- `ToolContext.onAskUser`
- `ToolContext.onApprove`
- `sessionApprovals` 做“本会话允许”的短路

这套方案优点是轻，但几个问题也很明显：

1. 审批/提问缺少 durable audit
2. 缺少明确的 policy 模型
3. 子运行、恢复运行、重放运行的语义不够稳定
4. “为什么这次弹审批/那次没弹”仍依赖日志和内存态判断

而 `deepseek-harness` 把 approval policy、asked/decided audit、root-agent 限制都做成了明确模型。

### 具体改造

建议在 `one` 中新增 `interaction/` 或 `hitl/` 域，逐步替代纯 callback 风格：

1. 新增 durable 事件或表
   - `approval_requests`
   - `user_questions`
   - 或全部先落到上面的 `run_events`

2. 定义 session 级 policy
   - `ask`: 正常询问
   - `never`: 自动拒绝
   - `session_allow_tool:<tool>`: 会话级放行某工具

3. 重构 `sessionApprovals`
   - 从纯内存判断升级成 “内存缓存 + 持久化事实”
   - 记录谁批准、批准范围、是否一次性、何时失效

4. 约束 ask_user 调用边界
   - 顶层首页运行允许提问
   - 非顶层 delegated 子运行默认不允许直接提问
   - 子运行若有未决问题，应把问题返回给父运行/顶层 UI

5. 在 UI 层展示更明确的 HITL 卡片来源
   - 来源节点
   - 来源工具
   - 所属 runId
   - 当前 policy

### 核心能力提升

- 审批和提问语义更稳定，不再强依赖“当前这次进程内的回调链”
- 更容易解释“为什么自动执行 / 为什么每步都停”
- 能支持会话级策略、恢复后继续、事后审计
- 为未来 shell/MCP/browser_use 这类高权限工具打更稳的基础

### Review 修订（2026-08-17，依据代码核对）

**修订 5：HITL durable 范围应区分——propose 草稿已有持久化，不重复造。**

依据：`src/main/ipc/home.ts:102` `persistCreateDraft` 已同步落盘 `drafts/`，`home.ts:112` `hydrateCreateDraftsFromDisk` 启动水合。即 propose 链路的“创建确认卡草稿”已经 durable + 可恢复。

结论：原文“审批/提问缺少 durable audit”对 approval_requests 和 user_questions 成立，但对 propose 草稿**不成立**。应明确：HITL 要补 durable 的是 `approval_requests` 和 `user_questions` 两类，propose 草稿已有持久化，可作为 durable HITL 的参照模板（它已趟过“落盘格式 + 启动水合 + 超时清理 + 上限防风暴”四件事），新写 approval/user_questions 的持久化时复用这套模式，不要另起。

**修订 6：policy 模型现状已有 `session_allow_tool`，缺的是 `never`。**

依据：`src/main/tools/sessionApprovals.ts:4` 注释“内存态：进程退出即清空；不写盘”，`:6` `approved = new Map<string, Set<string>>()`；`:42` `resolveApprovalDecision` 已实现 `approved`/`approved_session`/`denied` 三态。

结论：原文 policy 列的 `session_allow_tool:<tool>` One **已实现**（就是 `grantSessionToolApproval`）。真正缺的是 `never` 策略（自动拒绝某些工具）和 durable 审计（内存态进程退出即清空）。方向对，现状描述应修正为“已有 session_allow + 三态决议，缺 never 策略 + durable 落盘”。

**修订 7：子运行提问边界依赖 run 父子层级先建，不能与 HITL domain 并列独立。**

依据：`src/main/ipc/home.ts:447-491`（onAskUser）、`:461-479`（onApprove）——主 Agent 与组队节点的 HITL 桥都经同一 `waitForUserInput(requestId, ..., hitlRunId)` 队列，`hitlRunId = newRunId('home')`（`home.ts:375`）。即 One 当前**没有“子运行”概念**，组队节点和主 Agent 共享一个 runId 的同一提问队列。

结论：原文第 4 条“非顶层 delegated 子运行默认不允许直接提问，问题返回给父运行/顶层 UI”方向正确，但**前提是先引入 run 的父子层级**（即 P0-1 run_events 落地后才有“子 run”概念）。当前架构里组队节点不是独立 run，所以这条不能与 HITL domain 改造并列独立做，应标注为“**依赖 P0-1 run 父子层级先建，列为 HITL domain 的第二步**”。

---

## P0：把工具注册表升级为统一执行管线

### 当前差距

`one` 的工具注册表已经比普通“map<string, fn>”强很多了，已有：

- Zod 校验
- `preCheck`
- `approvalMode`
- 自动重试
- MCP 工具显式暴露控制

但问题是这些职责仍然集中在一个执行函数里，工具的：

- 策略
- 审批
- 超时
- 展示
- 审计
- 运行后处理

还没有被抽成标准阶段。

### 具体改造

建议保留现有 `registerTool()` API 外观，但在内部引入中间执行阶段：

1. 在 `src/main/tools/registry.ts` 内部抽出阶段接口
   - `preValidate`
   - `preCheck`
   - `authorize`
   - `execute`
   - `postProcess`
   - `finalizePresentation`
   - `audit`

2. 为工具定义补充元数据
   - `timeoutMs`
   - `presentationKind`
   - `supportsSessionApproval`
   - `writesWorkspace`
   - `logArgsPolicy`

3. 把部分逻辑从工具实现中上收
   - shell/MCP 的审批逻辑统一走 authorize
   - tool result 展示统一走 finalize
   - tool 审计统一走 audit

4. 给 MCP 工具与 builtin 工具用同一条执行管线
   - 这样后续 shell/browser_use/MCP 的行为差异就不是散落在各处 if/else

### 核心能力提升

- 新增工具的成本会下降，行为也更一致
- 更容易补日志、超时、重试、审批、UI 展示
- 能自然支持“工具调用为什么停、为什么失败、为什么展示成某种样子”
- 为工具生态扩张打地基，而不是每扩一种能力就长一套分叉逻辑

### Review 修订（2026-08-17，依据代码核对）

**修订 8：现状描述应修正——审批/策略/重试三层已有，缺的是从 if 分支提成可注册中间件链。**

依据：`src/main/tools/registry.ts:104` `executeTool` 函数体内已实现三段：
- `:119-133` Zod 入参校验（preValidate）
- `:136-148` `entry.def.preCheck` 硬拦截（preCheck，在审批闸门之前，避免“用户批准后才拦”的 UX 矛盾）
- `:152-188` `approvalMode === 'always'` 闸门 + `isSessionToolApproved` 会话级短路 + 300s 超时 + denied/timeout/unavailable 三态
- `:194-216` `skipRetry = approvalMode === 'always'`（always 工具不自动重试，避免绕过审批闸门）+ 其余重试 3 次 + 失败返回错误 JSON 不抛（铁律 11）

结论：原文“工具的 策略/审批/超时/展示/审计/运行后处理 还没有被抽成标准阶段”要修正为“**审批（approval）、策略（preCheck）、重试三层已在 executeTool 函数体内实现，但写死成 if/await 分支，缺的是把它们提成可注册的中间件链/阶段数组**”。这不是从零搭建，是把现有 if 改造成阶段数组。改造方向（保留 `registerTool()` API 外观、内部抽七阶段）正确且投入产出比最高，因为它直接为 CLAUDE.md 列的“shell/browser_use/MCP 未做”缺口铺路。

**修订 9：audit 应从“独立阶段”改为“result 阶段的 listener”，避免与 run_events 审计重复。**

依据：dsh 的工具执行流水线里，audit 不是独立阶段，而是 `tools/result` 同步通知（frozen 权威结果）的 consumer——监听者订阅 result 事件做审计，不进主执行链。One 若按原文把 `audit` 列为执行管线第七阶段，会与 P0-1 的 run_events（`tool.completed`/`tool.failed` 事件）重复造审计。

结论：把 `audit` 从七阶段之一改为“**execute 阶段产出的 result 经 finalize 后，作为 result listener 触发，写 run_events 的 tool.completed/tool.failed**”。这样审计只走一条路（run_events），不重复。七阶段可保留 `preValidate/preCheck/authorize/execute/postProcess/finalizePresentation`，audit 降级为 result 的 listener。

**补充：元数据清单与 dsh 对齐度高。**

依据：原文列的 `timeoutMs`/`presentationKind`/`writesWorkspace`/`logArgsPolicy` 与 dsh `ToolDefinition` 的 `timeoutMs`/`presentCall`+`presentResult`/`output.schema+render` 高度同构。`supportsSessionApproval` 是 One 特有（对应 `sessionApprovals` 会话级放行），合理保留。这组元数据点在点上，可直接采用。

---

## P1：把 Skill 从“instructions 注入器”升级成“可观测的 runtime provider”

### 当前差距

`one` 现在对 Skill 的核心判断是对的：Skill 是 ContextProvider，不是普通函数。  
但当前实现仍偏轻：

- `beforeRun` 注入 `<skill>` XML 和 discipline
- `afterRun` 只打一条总结日志
- 缺少每次注入的结构化记录
- 缺少 script 执行与 skill 生命周期的贯通追踪
- 没有 per-run skill state

### 具体改造

1. 给 Skill 注入建立结构化记录
   - 哪个 agent
   - 哪个 session/run
   - 注入了哪些 skill
   - 是否截断
   - 发现了哪些 scripts
   - 注入了哪些 discipline 块

2. `skill_run_script` 与 provider 关联起来
   - tool call 时写明来自哪个 skill
   - 失败时能反向定位到 skill id / script path

3. 为 provider 预留 state 通道
   - 即便先不完整实现，也建议把 `beforeRun/afterRun` 的签名为未来 state 留好位

4. 长期方向：把 skill source、skill provider、skill runtime record 拆开
   - 不是照搬 `deepseek-harness` 的 package 结构
   - 而是先在 `one` 内部把“技能文件管理”和“运行时注入”分成两个清晰子域

### 核心能力提升

- Skill 问题更容易定位，不再只看到“本轮注入了 3 个技能”
- 更容易分析“某技能是否真的参与了决策”
- skill script 的可解释性、可审计性更强
- 为 Skill RAG、Skill Registry、Skill 运行诊断形成闭环

### Review 修订（2026-08-17，依据代码核对）

**修订 10：现状属实，但优先级可进一步降为 P2，把 P1 位置让给测试门禁。**

依据：`src/main/skills/provider.ts:87` `beforeRun` 已返回 `injected: InjectedSkillInfo[]`（含 id/name/hasScripts/hasDiscipline），`:118` `afterRun` 确实只打一行 `logger.info`，`:112` `this.injected = injected` 已存了结构化数据但**未落库**。即原文说的“缺少每次注入的结构化记录”属实——数据已在内存，只是没持久化。

结论：Skill 的问题主要是“诊断不透明”，不影响功能正确性，收益相对 P0 三条偏低。原文放 P1 合理，但**建议进一步降到 P2**，把 P1 的位置让给测试门禁（理由见测试门禁 review 块：测试盲区是当前完全看不见的功能正确性风险，优先级应高于诊断透明度）。Skill 的结构化记录改造可并入 P0-1 run_events 的 `skill.injected` 事件——即 run_events 落地时顺手把 SkillContextProvider 的 `injected` 写一条事件即可，不必单独立项。

---

## P1：补“运行结果级”测试门禁，而不只停留在单测和 E2E 烟测

### 当前差距

`one` 目前的测试脚本比较轻量：

- `typecheck`
- `vitest`
- `playwright e2e`

这套对普通桌面应用够用，但对 agent runtime 不够。  
尤其当系统出现“逻辑没报错，但行为悄悄变了”的问题时，现有门禁不够敏感。

`deepseek-harness` 这里的强项不是测试数量，而是它把：

- transcript
- built artifact
- config composition
- runtime invariants

都纳入了必须过的 gate。

### 具体改造

建议 `one` 增加 4 类测试，不需要一步做满：

1. **主链路 transcript snapshot**
   - 首页主 Agent 直答
   - 首页转 capability
   - ask_user 中断/恢复
   - approval 请求/通过/拒绝
   - 创建确认卡补跑

2. **built artifact smoke**
   - 打包后应用最小启动
   - preload 白名单存在
   - 关键 IPC 可通

3. **runtime invariant test**
   - `sessionId` 隔离
   - always approval 工具不会自动重试
   - `shouldRespond=false` 不应伪装成真实执行完成
   - capability id 与文件名一致

4. **文档/配置 gate**
   - 内置资产清单与真实目录对账
   - registry manifest/schema 一致性
   - 必要时补简单 catalog 生成

### 核心能力提升

- 能更早发现“看起来没坏，其实行为变了”的回归
- 对 agent 行为修改更有信心
- 发布前不再主要依赖人工重走复杂路径
- 文档与代码脱节的问题会少很多

### Review 修订（2026-08-17，依据代码核对）

**修订 11：本条应从 P1 升为 P0，与 P0 三件事并列。**

依据：
- One 现状是 1 条 vitest lane + 5 个 e2e spec（`e2e/` 下 smoke/list-page/repro-capability/vault 四个 spec 文件），**无 coverage gate、无 snapshot、LLM 全 mock**。`vitest.config.ts` 只配了 `environment: 'node'` + `include: ['src/**/*.test.{ts,tsx}']`，CLAUDE.md §10.5 明确“LLM 调用一律 mock”。
- 这正是 dsh `testing.md` 警告的“单测绿、产品坏”盲区——dsh 作为 DeepSeek 自家，明确写“无 key 测试只证明管道通，with-key 才证明 agent 真能跑”。
- 原文 runtime invariant 列的 `shouldRespond=false` 不应伪装成真实执行完成——这条直接对应 CLAUDE.md 铁律 15 和 `src/main/orchestrator/runner.ts:360-362` 的 `allExplicitFalse` 求值逻辑，是真实存在的回归风险点。

结论：测试门禁的价值在于“功能正确性风险”，高于 Skill 诊断透明度（诊断 P2）和扩展点文档（纯文档 P1）。建议**升为 P0**，尤其是其中两项：
1. **transcript snapshot**——One 的 16 条编排铁律（cache_patch/dedup_patch/manager_fairness_patch/manager_output_patch/clean_conversation_for_handoff/repair_tool_pairs/wake_on_upstream 等）都是行为级的，正是 snapshot 黄金用例。录一次 LLM 响应重放比对，比断言“调了几次”更保真。
2. **真调 smoke**——至少加一两个真调 LLM 的 smoke（有 key 跑、无 key self-skip），验证首页直答→组队→HITL→创建确认整条链路，补当前完全看不见的盲区。

**修订 12：runtime invariant 第 2 条已有实现，应写成回归测试而非新约束。**

依据：`src/main/tools/registry.ts:194` `const skipRetry = entry.def.approvalMode === 'always'`——always 工具不自动重试的语义**已实现**。原文列它为 invariant test 是对的，但应明确这是“**回归保护已有行为**”，不是新约束——即测试要锁住“未来重构执行管线（P0-3）时这条语义不被破坏”。

---

## P1：把“新增能力应该挂在哪”写成扩展点文档

### 当前差距

`one` 现在有不少“铁律”和实现规范，这是很好的基础。  
但对未来新增能力，仍然比较依赖开发者自己理解代码结构后再决定挂点。

而 `deepseek-harness` 的优势在于：它会明确告诉你“加一个行为，应该挂到哪个 extension point”。

### 具体改造

建议新增一份偏运行时架构的文档，例如：

- `docs/RUNTIME_EXTENSION_MAP.md`

内容按问题组织，而不是按目录组织：

- 想加一个工具能力，改哪里
- 想加一个会话级策略，改哪里
- 想加一个技能运行时行为，改哪里
- 想加一个编排运行诊断点，改哪里
- 想加一个主助手路由行为，改哪里

最好每一条都给出：

- 推荐入口
- 不推荐入口
- 为什么

### 核心能力提升

- 后续多人或多轮 AI 协作时，改动更稳定
- 减少把行为写进错误层级的概率
- 降低系统复杂度继续膨胀时的认知成本

### Review 修订（2026-08-17，依据代码核对）

**修订 13：本条定位准确——零成本纯文档，可在 P0 改造并行期随手写，不必等到第三阶段。**

依据：
- dsh 的对应物是 `docs/architecture.md` 的 "Where new behavior goes" 扩展点表 + `docs/capability-seams.md` 的 capability seam 清单——两份都是纯文档，不改代码。
- One 的 CLAUDE.md 已有 16 条编排铁律 + 安全边界 5 条 + Skill 2 条，**这些铁律本身已经是"扩展点文档"的半成品**——只是它们按"规则"组织，没有按"我想加 X 行为，该改哪"组织。
- 改造点本身不动代码，风险为零；价值在于把 CLAUDE.md 已有的铁律从"约束清单"重组成"改动入口表"，让未来 AI 协作少走弯路。

结论：原文放第三阶段合理（先有改造事实才有扩展点可写），但建议**提前并行做**——P0 三个改造每动一个挂点，就同步往 `docs/RUNTIME_EXTENSION_MAP.md` 记一条"这次改的入口、不推荐入口、为什么"。这样文档是跟着改造长的，不是改造完再回溯补，保真度更高。零成本的事不必排期等。

---

## 补充对齐点（2026-08-17 二轮 review：原文未覆盖的 dsh 能力域）

二轮 review 逐包调研了 dsh `packages/*` 全部能力域，并逐条核实 One 侧现状。以下机制原文未提及，按「One 缺口是否真实」筛选后列出。

### 已对齐，不要重复造（核实结论）

- **credentials（凭据引用分离）**——One 已实现：`src/main/secrets/vault.ts` 用 Electron safeStorage（Keychain/DPAPI），provider 只存 `keyId` 引用、消费边界 `getKey()` 解析（`models.ts:399`），与 dsh CredentialRef 同构。
- **plan**——One 已有 `plan` 工具（`tools/builtin/plan.ts` + update_plan 桥）。
- **session-query / runtime-diagnostics 查询层**——原文 run diagnostics 查询层已覆盖其意图。

### 真实缺口（原文漏掉，按产品影响与依赖关系排序）

1. **上下文生命周期：摘要式 compaction + spill（大输出落盘）【P1：长会话核心能力】**
   - One 现状：runner 只有条数/token 截断（`runner.ts:334-355`）；工具输出硬截断（shell `STDOUT_MAX_CHARS=256KB` 超限直接杀，hint 让用户自己缩小范围）。
   - dsh 做法：`compaction` 包按 token 压力触发摘要 provider + 无模型 tool-result 裁剪；`spill` 包把超大工具输出落盘为 session 文件，内联替换为有界预览 + 检索定位符（模型可按需 grep 回原文）。
   - 价值：长会话存活 + 大输出不丢信息。修订 4 只提了 compaction 事务化，没提「摘要替代截断」和 spill 这两个独立机制。
2. **循环守卫 guard（重复工具调用检测）【P1：运行安全基线】**
   - One 现状：无任何重复调用检测，模型死循环调同一工具只能烧 token 到 maxIterations。
   - dsh 做法：`guard` 包以工具/agent 事件监听实现重复调用提醒 + per-call 超时预算。
   - 价值：防跑偏，语义与工具执行管线生命周期绑定——作为管线的一个守卫中间件落地（依赖第一阶段第 4 项的中间件链），而非独立旁路。
3. **后台任务协议 jobs【P2】**
   - One 现状：工具全部同步阻塞（shell 120s 超时杀进程组）；`askUser.ts:6` 注释已预留「未来后台任务」。
   - dsh 做法：`jobs` 包提供 owner 隔离的后台 job 注册表，支持观察/取消/等待/完成通知回投会话。
   - 价值：长时工具（构建、批量处理、poster 截图批量化）不阻塞会话。依赖 run_events 落地后做更顺。
4. **运行时不变量注册表（运行态，非测试态）【P2】**
   - dsh `runtime-diagnostics`：各包通过 `./invariant` 伴随模块注册契约检查，违规运行期即抛——与原文测试门禁（测试态 invariant）互补，One 可轻量借鉴（如 sessionId 隔离、stopReason 枚举越界时主进程 warn）。
5. **durable 目标/提醒（goal/schedule）【P3，长期】**
   - dsh 把会话目标、定时提醒写回 session log，冷会话复活补投逾期项。One tasks 表只是历史记录，无 resume/补投语义。列入 event log 落地后的演进项。
6. **外部 hooks 协议桥接【P3，生态项】**
   - dsh `hooks` 复用 Claude Code/Codex 的 hooks.json 协议。One 若未来要兼容外部生态再做，当前无用户诉求。
7. **sandbox 进程隔离【P3，长期安全项】**
   - dsh 按会话 confinement + fail-closed。One shell 目前只有 preCheck 黑名单，桌面个人工具可接受，列为高权限工具（browser_use 等）落地前的安全前置。
8. **subagent 隔离上下文子代理【P3】**
   - 修订 7 提了 run 父子层级，但 dsh subagent 更宽：隔离 context 的 fork、可续跑后台子代理、跨进程 ACP 委托。One 的组队节点共享会话上下文，隔离子代理是更远的演进，暂记一笔。

## 明确不建议照搬的部分

以下内容不建议直接从 `deepseek-harness` 平移到 `one`：

1. **200+ package 的大规模 monorepo 拆分**
   - `one` 当前还是单产品桌面应用，直接照搬会大幅增加维护成本

2. **所有能力都插件化**
   - `one` 当前最重要的是产品交付效率，不是做一个通用 agent SDK

3. **全量 Cordis 风格运行时**
   - 其思想可以学，但不应该把 `one` 重写成另一种框架

更合理的方向是：

- 保持 `one` 作为产品应用的整体结构
- 在关键底层域中吸收 `deepseek-harness` 的工程方法
- 先做“事实流、HITL domain、工具 pipeline、测试 gate”这四件高收益改造

---

## 推荐改造顺序

> **Review 后的顺序（2026-08-17）**：原文把 `run_events` 列为第一阶段第 1 项，但代码核对发现 One 已有半成品崩溃草稿恢复（哨兵/listDrafts/hydrateCreateDraftsFromDisk）。跳过半成品直接搭 run_events 会让两套”运行态恢复”并存且语义打架。顺序据此重排，详见各章节 Review 块的修订 1/5/7/10/11/13。

### 第一阶段：先闭环半成品，再叠事实流（高收益、低重构风险）

1. ~~**先闭环已有崩溃草稿恢复**~~ ✅ **已完成（2026-08-17，`4ebfa19` + `a126eb6`）**——HomePage/EditorPage 挂载灌回 + CrashRecoveryDialog 恢复按钮导航已落地；弹窗 pull 通道补 `hadCrashedLastRun` 过滤（正常退出不误弹）。修订 1 的前提已消除，第一阶段从第 2 项开始。
2. **`run_events` 基础设施**——在草稿恢复骨架之上叠加，先窄后宽，只覆盖原文点名的 5 个诊断问题（修订 3）。若后续演进到 append-only event log，compaction 需配套事务化（修订 4）。
3. **approval / ask_user durable audit**——propose 草稿已有持久化作模板，只补 `approval_requests`/`user_questions` 两类，加 `never` 策略（修订 5、6）。
4. **工具执行管线内部重构**——把现有 if/await 三段提成可注册中间件链，audit 从独立阶段降为 result listener，避免与 run_events 重复（修订 8、9）。

### 第二阶段（与第一阶段并列，可并行启动）：测试门禁

> Review 升 P0（修订 11）。测试盲区是当前完全看不见的功能正确性风险，高于诊断透明度，不必等第一阶段全做完再启动。

1. **transcript snapshot**——16 条编排铁律都是行为级，录一次重放比对最保真。
2. **真调 smoke**——有 key 跑、无 key self-skip，补首页直答→组队→HITL→创建确认盲区。
3. **runtime invariants**——其中”always 工具不自动重试”是回归保护已有行为（修订 12），锁住第一阶段重构执行管线时不破坏此语义。

### 并行（零成本，跟着改造随手写）

- **`docs/RUNTIME_EXTENSION_MAP.md`**——纯文档，P0 每动一个挂点就记一条入口/不推荐入口/为什么（修订 13）。

### 第三阶段：增强长期演进能力（依赖前两阶段落地）

1. **HITL 子运行提问边界**——依赖 run 父子层级先建，不能独立做（修订 7）。
2. **Skill runtime record**——降 P2，并入 run_events 的 `skill.injected` 事件即可，不必单独立项（修订 10）。
3. **compaction 事务化**——仅当 event log 演进到 append-only 时才需要（修订 4）。
4. **更细的 session/run 查询与诊断 UI**。

---

## 最终建议

如果只做一件事，优先做：

**把运行时关键事实从”日志副产物”升级成”一等持久化对象”（run_events）。**

> 二轮 review 更新（2026-08-17）：原建议的前半句「先闭环已有崩溃草稿恢复」已于当日完成（`4ebfa19` + `a126eb6`），前提消除，下一步直接从 run_events 开始。另：上下文生命周期（摘要式 compaction + spill）与循环守卫是原文漏掉的关键对齐点，见「补充对齐点」节。

> Review 修正（2026-08-17）：原文只提”把事实升级成一等持久化对象”，但代码核对发现 One 不是从零搭事实流——`crash-recovery.ts` 已有哨兵/listDrafts，`home.ts:102/112` 已有 propose 草稿落盘+水合。所以最该先做的是”闭环这半成品”，再叠加 run_events。跳过半成品直接搭事实流，会让两套运行态恢复并存且语义打架（修订 1）。

这是最像 `deepseek-harness`、同时也最适合 `one` 当前阶段的一项吸收点。  
它会同时提升以下能力：

- 问题定位
- 行为解释
- 审批/HITL 语义稳定性
- 回归测试能力
- 崩溃恢复与运行回放

也是后续继续做 shell / browser_use / MCP / Skill 生态深化时，最不容易后悔的一次底层投资。
