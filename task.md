# One — 实施任务清单

> 依据 `docs/REWRITE_PLAN.md §八` 分阶段计划。每完成一项把 `[ ]` 改 `[x]`，并在行尾补 commit 短哈希 / 日期。
> 阶段 0（脚手架）已完成于 `2f759db`（M0 骨架修复）。

---

## 阶段 0：脚手架与基础设施 ✅ M0

里程碑：桌面壳能打开，主题化骨架页渲染，IPC 双向通路通，测试 + i18n 脚手架就绪。

- [x] electron-vite 三端工程（main/preload/renderer）`2f759db`
- [x] tsconfig + electron-builder.yml（mac 本地）`2f759db`
- [x] 主进程最小窗口 + preload 白名单 + hello IPC `2f759db`
- [x] Tailwind v4 + 主题 token + 品牌色 + 玻璃配方变量 `2f759db`
- [x] hashRouter 壳 + AppShell（TitleBar/IconRail/SideList/MainArea/Inspector/CommandPalette）`2f759db`
- [x] Zustand + TanStack Query 接入 `2f759db`
- [x] electron-log 接入 `2f759db`
- [x] vitest + Playwright Electron 脚手架 `2f759db`
- [x] i18next + react-i18next + namespace 文件 + 懒加载 `2f759db`
- [x] 全局错误兜底（主进程 + 渲染层）`2f759db`
- [x] sandbox:true + 单例锁 + CJS preload 产出 `2f759db`
- [x] IPC withHandler 结构化错误 + 原子写盘 `2f759db`
- [x] OKLCH 点缀色派生 + 防首屏闪白 `2f759db`

---

## 阶段 1：存储与配置（M1）✅

里程碑：模型配置、角色、技能、能力列表页能用（只读 + 增删改）。

- [x] 1.1 `better-sqlite3` 接入 + electron-rebuild 集成（postinstall 钩子）`c11bdb5`
- [x] 1.2 `storage/db.ts`：WAL + schema 迁移（版本表）+ `integrity_check` 启动校验 + 损坏备份恢复 `c11bdb5`
- [x] 1.3 SQLite schema：sessions / messages / tasks / memory_l1 / memory_l2 / memory_l3 `c11bdb5`
- [x] 1.4 `config.ts`（Zod schema，与 shared 接口手工对齐）+ models.json 迁 userData `c11bdb5`
- [x] 1.5 `secrets/vault.ts`：Electron safeStorage 加密 LLM key（明文不出主进程）`c11bdb5`
- [x] 1.6 存储 CRUD：models/capabilities/agents/skills/persona/sessions/tasks `c11bdb5`
- [x] 1.7 IPC 全量 channel（8 namespace）+ preload `OneApi` + 渲染层 `api/` TanStack Query `c11bdb5`
- [x] 1.8 管理后台列表页接真实数据（加载/空/错误态 + 新建/删除）`c11bdb5`
- [x] 1.9 集成测试：E2E agents CRUD 落盘 + vault roundtrip + smoke（独立 userData 隔离）`c11bdb5`
- [x] 1.10 typecheck + build + 5 单测 + 3 E2E 全绿 `c11bdb5`

> 实施说明：native 模块（better-sqlite3 / safeStorage）走 E2E 而非 vitest（ABI 匹配）；E2E 串行执行 + `ONE_USER_DATA` env 隔离 userData，避免单例锁与 SQLite 并发冲突。

---

## 阶段 2：LLM 与单 Agent 聊天（M2）✅

里程碑：首页能跟主助手多轮对话，流式输出 + 工具调用。

- [x] 2.1 `llm/client.ts`：Anthropic TS SDK 封装，`beta.messages.stream()`，system 抽顶层，role/content 映射 `6bcbdf3`
- [x] 2.2 `llm/retry.ts`：指数退避 1/2/4s + ±20% jitter，429/5xx/网络/中转关键词重试，401/400 不重试，包 `LLMClient.stream()` 外层（铁律10），client 按 modelId 缓存 `6bcbdf3`
- [x] 2.3 `max_tokens` 走 defaultOptions（铁律8，缺省 16384）`6bcbdf3`
- [x] 2.4 `tools/registry.ts`：Zod 显式 JSON Schema，失败重试 3 次返回错误 JSON 不抛（铁律11/§J）`6bcbdf3`
- [x] 2.5 单 Agent 执行单元（tool-use 循环借力 SDK，铁律6）`6bcbdf3`
- [x] 2.6 流式 token 经 `webContents.send('home:stream')` → 渲染层 onStream `6bcbdf3`
- [x] 2.7 首页主助手聊天页打通（不含记忆）`6bcbdf3`
- [x] 2.8 单测：重试策略（6 case）+ 工具注册表（5 case），mock LLM `6bcbdf3`

> 实施说明：RetryingClient 用 duck-type 接受 mock 注入（instanceof 在测试 mock 失效）；中转代理用 `defaultHeaders` 注 Authorization Bearer（fetchOptions.headers 类型 NotAny 包装不可用）；zod v4 用 `_def.type` 字符串标识替代 v3 的 `typeName`。

---

## 阶段 3：三级记忆（M3）✅

里程碑：多会话后记忆生效，任务进度页可用。

- [x] 3.1 L0 身份块（persona.profile → injectL0 拼 instructions 开头）`4783716`
- [x] 3.2 L1 滚动压缩（超 20 条触发，LLM 压缩存 memory_l1，受阻截断兜底；buildL1Messages 注首条+最近 8 条窗口）`4783716`
- [x] 3.3 L2 跨会话精炼（会话结束 LLM 精炼存 memory_l2，注入 persona 限长 1500 字）`4783716`
- [x] 3.4 L3 长期沉淀（memory_l3 key-value + memory_recall/search/retain 工具）`4783716`
- [x] 3.5 会话/任务历史查询页（TasksPage + AppShell 侧栏 sessions）`4783716`
- [x] 3.6 L1 与 agent compaction 关系厘清（L1 会话级摘要先存档，compaction 运行时窗口截断防超 token）`4783716`
- [x] 3.7 单测：L0 纯函数 5 case；L1/L2/L3 走 E2E（native SQLite + LLM 需真实环境）`4783716`

> 实施说明：L1/L2 的 LLM 压缩用独立 compressFn（system prompt「摘要助手」+ maxTokens 1024），失败降级截断；L2 注入限长 1500 字超出按最早条目截断；L3 search 用 LIKE 模糊匹配（向量检索后置）。

---

## 阶段 4：编排引擎（M4）

里程碑：画布编排能跑 Sequential/Concurrent/GroupChat/Handoff；Magentic 降级提示。

### 4a：Sequential + Concurrent + Agent 叶子（✅ 第一批）

- [x] 4a.1 `orchestrator/models.ts`：Executor/ExecutorRequest/WorkflowContext/RuntimeWorkflow 抽象 + shared 补 OrchMessage/MessageEnvelope（铁律7/15）`914ca5e`
- [x] 4a.2 `runner.ts`：Pregel superstep 主循环（非递归，单 pending buffer）+ Promise.all 并发 deliver + 收敛 + MAX_SUPERSTEPS 兜底 `914ca5e`
- [x] 4a.3 `builder.ts`：JSON 图→RuntimeWorkflow，环检测（DFS 三色），按 type 分发，无静态排序 `914ca5e`
- [x] 4a.4 Sequential + Agent 叶子（wake_on_upstream 治复述 / strip_tool_blocks_filter 治 2013）`914ca5e`
- [x] 4a.5 Concurrent fan-out/fan-in（ConcurrentExecutor 协调）`914ca5e`
- [x] 4a.6 条件边 `contains:` 谓词 + 恒真（runner evaluatePredicate）`914ca5e`
- [x] 4a.7 黄金用例：Sequential 4 case（接力/单 agent/wake/strip）+ Concurrent 2 case（fan-out/should_respond=false）`914ca5e`

> 4a 修复：Pregel 单 pending buffer（原双 buffer nextPending 导致下轮误判收敛，B 永不 deliver）。

### 4b：GroupChat + Handoff（⚠ 待推进，最高风险）

- [x] 4b.1 GroupChat：broadcast（should_respond=false 仅 extend cache）+ 定向请求 next_speaker（should_respond=true run）+ round_robin selection_func + max_rounds 终止 `46270e4`
- [x] 4b.2 GroupChat 四 patch：cache_patch（自带完整历史治空 cache）/dedup_patch（去重）/manager_fairness_patch（未发言强制 terminate=false）/manager_output_patch（剥围栏+鲁棒 JSON） `46270e4`
- [x] 4b.3 GroupChat manager：AgentOrchestrationOutput 结构化输出 + extractManagerOutput/applyFairnessPatch（selectNextSpeaker manager 模式降级 round_robin，TODO） `46270e4`
- [x] 4b.4 Handoff：synthetic tool handoff_to_X + _AutoHandoffMiddleware 短路（agent 循环检测 handoff tool 注入合成 result + break，等价 MiddlewareTermination）+ HandoffExecutor 扫 function_result 解析 target + clean_conversation_for_handoff `46270e4`
- [x] 4b.5 Magentic 占位降级（抛提示改用 groupchat+handoff）`46270e4`
- [x] 4b.6 编排 IPC + 流式（orchestrate:run/onStream/cancel + preload namespace）`46270e4`
- [x] 4b.7 黄金用例：GroupChat 四 patch 9 case + Handoff 5 case + 阶段4 验证 `46270e4`
- [ ] 4b.8 画布编辑器联调（NodeInspector/NodePalette/nodes）—— 阶段5 前端重写时接

---

## 阶段 5：前端 UI 重写（并行，M5）

里程碑：核心页面视觉与交互重写完成，主题系统可用。

- [ ] 5.1 设计令牌 + ShadCN 基础组件定制（Button/Input/Dialog/Drawer/Toast/Tabs/Table）
- [ ] 5.2 主题系统全量（预设/明暗/点缀色/背景图/玻璃参数/密度/字号/对比度兜底）
- [ ] 5.3 首页主助手聊天（消息流/流式光标/Markdown/代码块/工具卡片/停止重发）
- [ ] 5.4 能力编排画布（6 类节点视觉/NodeInspector/NodePalette/连线条件边/运行态高亮）
- [ ] 5.5 管理后台统一表格+表单范式（空态/加载态/错误态）
- [ ] 5.6 设置页（个人档案/外观/LLM/快捷键/自启/日志）
- [ ] 5.7 CommandPalette（⌘K）全局导航/搜索/动作
- [ ] 5.8 i18n 全量（home/editor/settings/errors namespace + 日期 Intl）
- [ ] 5.9 微动效（Framer Motion）

---

## 阶段 6：原生能力与打磨（M6）

里程碑：可分发的双平台安装包，自动更新闭环。

- [ ] 6.1 托盘 + 全局快捷键 + 原生菜单
- [ ] 6.2 自动更新（electron-updater）
- [ ] 6.3 通知 + 开机自启 + 明暗跟随系统
- [ ] 6.4 崩溃恢复（crashReporter + 启动哨兵 + 草稿恢复）
- [ ] 6.5 存储恢复（SQLite WAL + integrity_check + 损坏备份恢复）
- [ ] 6.6 打包 mac/win，安装包验证

---

## 阶段 7：工具与 MCP（持续）

- [ ] 7.1 内置工具 TS 重写（shell / 文件 / grep / glob / browser_use / desktop_screenshot）
- [ ] 7.2 MCP 工具协议接入（@modelcontextprotocol/sdk）
- [ ] 7.3 即梦文生图等外部工具
