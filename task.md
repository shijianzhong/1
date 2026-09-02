# One — 实施任务清单

> 依据 `docs/REWRITE_PLAN.md §八` 分阶段计划。每完成一项把 `[ ]` 改 `[x]`，并在行尾补 commit 短哈希 / 日期。
> **本文件是实现进度权威源**；`CLAUDE.md`「当前阶段」与 `REWRITE_PLAN` §八 应与此对齐。
> 阶段 0（脚手架）已完成于 `2f759db`（M0 骨架修复）。
>
> **快照 2026-08-24**：M0–M6 ✅ · M7 ⏳（web/file/opencli/ask_user/shell/grep/glob/MCP 已落地，desktop_screenshot/chrome-devtools-mcp/即梦文生图 未做）。HITL 与编辑器运行聊天化已落地；当日全量代码 review 实证缺口已并入文末「已知缺口」（含误报排除清单，勿再报）。

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

> 实施说明：L1/L2 的 LLM 压缩用独立 compressFn（system prompt「摘要助手」+ maxTokens 1024，抽到 `llm/compress.ts` home/orchestrate 共用），失败降级截断；L2 注入限长 1500 字超出按最早条目截断；L3 search 用 LIKE 模糊匹配（向量检索后置）。编排路径已注入 L0+L2 并在 converged 收尾精炼 L2 落 `memory_l2`（`orchestrate.ts`，对齐首页 `ipc/home`）；L1 滚动压缩仍仅首页（编排无 L1 层）。

---

## 阶段 4：编排引擎（M4）✅ 已收口 `4dd76dc`

里程碑：画布编排能跑 Sequential/Concurrent/GroupChat/Handoff 且语义保真；Magentic 降级提示。**M4 收口完成于 `4dd76dc`。**

### 4a：Sequential + Concurrent + Agent 叶子（✅）

- [x] 4a.1 `orchestrator/models.ts`：Executor/ExecutorRequest/WorkflowContext/RuntimeWorkflow 抽象 + shared 补 OrchMessage/MessageEnvelope（铁律7/15）`914ca5e`
- [x] 4a.2 `runner.ts`：Pregel superstep 主循环（非递归，单 pending buffer）+ Promise.all 并发 deliver + 收敛 + MAX_SUPERSTEPS 兜底 `914ca5e`
- [x] 4a.3 `builder.ts`：JSON 图→RuntimeWorkflow，环检测（DFS 三色），按 type 分发，无静态排序 `914ca5e`
- [x] 4a.4 Sequential + Agent 叶子（wake_on_upstream 治复述 / strip_tool_blocks_filter 治 2013）`914ca5e`
- [x] 4a.5 Concurrent fan-out + fan-in 栅栏（等齐再聚合，runner superstep 末尾扫描）`914ca5e` + `4dd76dc`
- [x] 4a.6 条件边 `contains:` 谓词 + 恒真 + GraphEdge.condition → conditions 映射（builder addCondition）+ 未命中走普通边兜底 `914ca5e` + `4dd76dc`
- [x] 4a.7 黄金用例：Sequential 4 case（接力/单 agent/wake/strip）+ Concurrent 2 case（fan-out/should_respond=false）`914ca5e`

> 4a 修复：Pregel 单 pending buffer（原双 buffer nextPending 导致下轮误判收敛，B 永不 deliver）。

### 4b：GroupChat + Handoff（✅ 运行时保真已通）

- [x] 4b.1 GroupChat：round_robin 容器骨架 `46270e4`；runner shouldRespond 双语义接线 + broadcast「仅 extend cache」已通 `4dd76dc`
- [x] 4b.2 GroupChat 四 patch：纯函数 + 运行时 handle 完整调用（dedup/cache/repair/fairness/manager_output）`46270e4` + `4dd76dc`
- [x] 4b.3 GroupChat manager：结构化输出接线（本地调 orchestrator agent 拿 AgentOrchestrationOutput，不经 superstep）；fairness 首轮跳过；解析失败降级 round_robin `46270e4` + `4dd76dc`
- [x] 4b.4 Handoff：synthetic tool + Agent 短路 + HandoffExecutor 路由基本可用 `46270e4`
- [x] 4b.5 Magentic 占位降级（抛提示改用 groupchat+handoff）`46270e4`
- [x] 4b.6 编排 IPC + 流式（orchestrate:run/onStream/cancel + preload namespace）`46270e4`
- [x] 4b.7 单测：GroupChat 四 patch + Handoff 辅助 `46270e4`
- [x] 4b.8 画布编辑器联调（EditorPage + Agent/Container NodeView + 运行高亮）—— 可持续打磨
- [x] 4b.9 **M4 收口清单**（`4dd76dc`）：shouldRespond 接线 ✅ · Concurrent fan-in ✅ · manager 结构化输出接线 ✅ · repair_tool_pairs ✅ · outputConstraints 注入 instructions ✅ · 完整 context_mode（strip_tool_blocks_filter 已在 constraints.ts，Sequential 下游接入待联调）· 首页意图路由（铁律 24，移交 M5 后续，已落地 `b192df4`）

---

## 阶段 5：前端 UI 重写（并行，M5）✅ 骨架 · i18n 未清零

里程碑：核心页面视觉与交互重写完成，主题系统可用。

- [x] 5.1 设计令牌 + ShadCN 基础组件（Button/Input/Dialog/Drawer/Toast/Tabs/Table/Switch/Badge + cn utils）`d485ef0`
- [x] 5.2 主题系统全量（预设/明暗/点缀色色板/背景图导入/玻璃参数/密度/字号 + 主题 IPC pickBackground/importBackground/loadBackground/removeBackground）`d485ef0`
- [x] 5.3 首页主助手聊天（Markdown 渲染 remark-gfm/rehype-highlight/katex + 流式光标 + 消息进入动效）`d485ef0`
- [x] 5.4 能力编排画布（@xyflow/react + 6 类节点 NodePalette 拖拽建图 + 运行态高亮 + Inspector 输出 + orchestrate 联调）`d485ef0`
- [x] 5.5 管理后台列表范式（Table hover 浮起 + Drawer 编辑 + 空态/加载态/错误态规范）`d485ef0`
- [x] 5.6 设置页全量（个人档案/外观/LLM 配置/关于）`d485ef0`
- [x] 5.7 CommandPalette（⌘K 搜索过滤 + 键盘上下选择 + 回车执行 + 淡入动效）`d485ef0`
- [x] 5.8 i18n 全量（namespace keys 补齐 + **硬编码清零** + Intl.DateTimeFormat）✅ 2026-08-21（REVIEW #27 收口）—— 脚手架有；Editor/Agents/Skills/Home 等硬编码已清零；`errors.json` zh-CN/en 各 87 key、完全对齐；主进程结构化错误 key（`errors:*`）已对齐
- [x] 5.9 微动效（framer-motion：消息进入 + 命令面板淡入）`d485ef0`

---

## 阶段 6：原生能力与打磨（M6）✅ 部分

里程碑：可分发的双平台安装包，自动更新闭环。

- [x] 6.1 托盘（右键菜单 显示/设置/退出）+ 全局快捷键 CmdOrCtrl+Shift+E 唤起 + 原生菜单（文件/编辑/视图/窗口/帮助）`2b4723d`
- [x] 6.2 自动更新（electron-updater 启动检查 + 4h 定时，dev 跳过，update-available/downloaded 推渲染层）`2b4723d`
- [x] 6.3 通知（Notification）+ 开机自启（setLoginItemSettings）+ nativeTheme 明暗跟随（主动查询 + 系统变化推送）`2b4723d`
- [x] 6.4 崩溃恢复主进程（.running 哨兵 + 启动检测 + app:crashRecovery + listDrafts/removeDraft）`2b4723d`；**[ ] 草稿写盘（编辑器/聊天）+ 渲染层订阅恢复 UI 未闭环**
- [x] 6.5 存储恢复完善（周期备份 30min + 退出前备份 .bak，SQLite WAL + integrity_check 已在 1.2 做）`2b4723d`
- [x] 6.6 打包 mac dmg（release/One-0.1.0.dmg）`2b4723d`；**[ ] win nsis 未验**
- [x] 6.7 应用图标合规化（2026-08-03）：源 logo.png 无 alpha 且 .ico 实为 PNG 改名（假 ICO）→ 生成透明背景版 `build/icons/logo_trans.png`（**HSV 判定**：V>215 且 S<38 判为背景一次性全局清，含 logo 内部封闭留白、抗锯齿过渡带、右下浅蓝光晕区；flood-fill 不可行会被过渡带断流，RGB 通道差法误伤浅蓝渐变。阈值 S<38 覆盖纯白背景(S≈1)+浅蓝光晕(S=25-34)，深蓝 logo 本体(S>=45)误伤 0。最终透明 92.24%、残留 0）；经 iconutil 产出多尺寸真 `.icns`（7 尺寸含 @2x）、经 PIL 产出多尺寸真 `.ico`（16/24/32/48/64/128/256）；托盘 mac 走 `trayTemplate.png`（单色+alpha，`setTemplateImage(true)` 随菜单栏明暗反色）、win/linux 走 `tray.png`（带色 32x32，extraResources 复制为 trayColor.png）；`electron-builder.yml` mac/win/linux icon 指向 `build/icons/*`。打包验证：`One.app/Contents/Resources/icon.icns` MD5 与源一致，`Info.plist:CFBundleIconFile=icon.icns`，tray 两图就位。标题栏 UI 仍用原 `logo.png`（白底 glass panel，不改）

> 修复：electron-updater ESM/CJS import（default import 解构）；测试环境 NODE_ENV=test 跳过托盘/菜单/快捷键。

- [x] 6.8 冷启动性能修复（2026-08-04，实证驱动）：打包版「白屏久 → 连接桌面壳 → 进应用」根因 = 渲染层冷启动链（主进程实测 180ms 就绪非瓶颈）。修复：① `index.html` 内联纯 HTML/CSS 启动屏（#FCFCFD + #4ECDC4 品牌标 + 呼吸点，带 `prefers-reduced-motion` 兜底），React 挂载自动替换；② renderer 分包 `manualChunks`（reactflow/katex/markdown/motion/ui/vendor）+ 路由懒加载（HomePage 保留首包，AppShell `<Outlet/>` 外套 Suspense/PageLoading），**启动预载 3.0MB → 1.2MB**（markdown 1.2MB/katex 484KB/reactflow 357KB 全部移出首包）；③ 堵静态回链：`CreateConfirmCard` 的 GraphPreview 抽 `GraphPreview.tsx` 懒加载；④ `Markdown` 组件懒加载（fallback 纯文本先呈现后升级）；⑤ MessageItem 入场动效 framer-motion（270KB，全项目仅此一处）改 CSS `message-enter` keyframes；⑥ i18n 首包 zh-CN/common 内联进 bundle（`partialBundledLanguages:true`，消灭 file:// fetch 串行点，单一事实源仍是 public 下文件）；⑦ `writeJsonAtomic`/`writeJsonFile` 临时名加随机后缀（修主题连发 rename ENOENT 风暴）。验证：typecheck/265 单测/4 E2E 全绿。

- [x] 6.9 哨兵写入 + updater 406（2026-08-05）：① `.running` 改落 `userData/.running`（旧 `drafts/../.running` 在 drafts 未建时内核路径 ENOENT，每次启动「哨兵文件写入失败」、崩溃检测失效）；`removeDraft` 拒路径穿越；② updater：draft-only / 406 / Unable to find latest version 归为预期态，进程内只 info 一行且不刷 HTML feed；摘掉 `autoUpdater.logger=electron-log`；首检延迟 15s；显式 `package.json#repository` + `electron-builder.yml#publish`（`shijianzhong/1`，与 origin 一致）；CI 注释标明 draft 需 Publish 后 updater 才生效。单测 +7（crash-recovery/updater-errors），全量 272 绿。

---

## 阶段 7：工具与 MCP（持续）

- [x] 7.1 内置工具 TS 重写（shell / grep / glob / desktop_screenshot）✅ —— 已有 `memory_*` / `propose_*` / `ask_user` / `web_search` / `web_read` / `opencli_run` / `file_write` / `file_read` / `file_search` / `shell_run` / `shell` / `grep` / `glob`；**browser_use 替换为 chrome-devtools-mcp（Google 官方 MCP Server，计划走现有 MCP 客户端接入，见 7.3，未做）**；desktop_screenshot 未做
- [x] 7.1d shell_run 工具（2026-08-05）：`spawn` async + 进程组 SIGKILL + 120s 默认超时（max 300s）+ stdout 256KB 上限 + env 敏感值过滤（`_KEY`/`_SECRET`/`_TOKEN`/`_ID` 后缀置空）+ `DANGER_PATTERNS` preCheck 硬拦 + approvalMode='always'；**本会话允许**（2026-08-06：`approved_session` → sessionApprovals 放行表，同会话同工具跳过弹窗；危险命令仍硬拦）
- [x] Agent `maxIterations` 默认 10→32；触顶且末轮仍 tool_use 时强制无工具收尾轮 + `hitIterationLimit` / `message_stop: max_iterations`（2026-08-06，防半截话当终局）
- [x] 聊天创建确认卡回合结束被清空修复（2026-08-06）：`listPendingDrafts` + 草稿打 sessionId；回合结束/切会话重挂未确认卡；创建指令严禁幻觉「已入库」
- [x] 创建幻觉强制补跑（2026-08-06）：`needsCreateRecovery` 检测「已入库/没有持久化/只是模拟」且未调 propose_* → 只挂创建工具再跑一轮弹出确认卡
- [x] 聊天创建入库根治 A+B1/B2/B4（2026-08-07）：四类 `propose_*` 描述对称防幻觉；扩展幻觉词表 + R1 kind 定向补跑；`proposal_error` 失败卡可重试；`meta.create` proposed/confirmed；待确认指示条；补跑失败 notice + i18n；见 `docs/CHAT_CREATE_PERSISTENCE_FIX.md`（C 期 tool_choice/草稿落盘延后）
- [x] 7.1c 文件工具（2026-08-01）：`file_write`（原子写/自动建目录/append）+ `file_read` + `file_search`（文件名+内容 OR 匹配）；路径围栏限允许根目录（默认 `~/sh/DailyNotes` Obsidian vault + `userData/exports`，`config/file-roots.json` 或 `ONE_FILE_ROOTS` env 扩展）；4 个 skill 的 agent-reach/search_files 失效引用已全部改指真实工具
- [x] 7.1a 联网工具（2026-08-01）：`web_read`（Jina Reader 免 key）；`web_search`（默认 Bing CN HTML 免 key国内直连，摘要自带相对日期；`JINA_API_KEY` 切 Jina Search；4xx 不重试直接结构化错误）；`opencli_run`（OpenCLI 白名单 spawn，写操作动词拦截，退出码→可行动提示；生产走随包 `vendor/opencli` + `ELECTRON_RUN_AS_NODE` 用户零安装，开发回退系统 PATH）
- [x] 7.1b `opencli_run` 增强：以 `cli-manifest.json` 的 `(site,verb)→access` 白名单做写拦截（自维护，替代静态动词表）；fail-closed（未知命令默认拒绝）；降级黑名单兜底 ✅ 2026-08-17（代码逻辑就绪，`cli-manifest.json` 数据文件待随包 `vendor:opencli` 落地后白名单才生效，当前实际跑降级黑名单模式）；Chrome 扩展未连接的首次运行引导 UI 未做
- [x] 7.2 MCP 工具协议接入（@modelcontextprotocol/sdk）✅ 2026-08-05
  - `tools/mcp/client.ts`：Client 管理器——stdio（StdioClientTransport 子进程）+ HTTP（StreamableHTTPClientTransport）双 transport；connect/disconnect/disconnectAll；意外断连自动清理；onclose/onerror 日志
  - `tools/mcp/adapter.ts`：MCP 工具 → registry 适配——`mcp__{serverId}__{toolName}` 命名；AJV 运行时入参校验（绕过 zodToJsonSchema 限制）；`inputSchemaOverride` 直传原始 JSON Schema 给 LLM；CallToolResult content 提取文本；approvalMode 默认 always（MCP 工具行为未知，安全起见每次确认）
  - `tools/mcp/config.ts`：配置持久化（`config/mcp-servers.json`，原子写盘 tmp+rename）；CRUD + loadMcpConfig
  - `tools/mcp/index.ts`：入口——`initMcpServers()` 启动时并行连接 enabled 服务器（不阻塞 app ready）；`disconnectAll()` 退出清理
  - `ipc/mcp.ts`：7 个 IPC handler——listServers/addServer/updateServer/removeServer/connectServer/disconnectServer/testServer
  - `preload/index.ts`：`window.one.mcp.*` 命名空间
  - `renderer/components/McpSettings.tsx`：MCP 管理面板——服务器列表（连接状态 + 工具数 badge）+ 添加/编辑/删除/连接/断开/测试连接表单
  - `renderer/pages/McpPage.tsx`：独立顶级导航页 `/mcp`（PageToolbar + McpSettings），与 Models 平行——均为「给 Agent 接外部服务」的连接配置；Settings 回归静态偏好，运行时连接管理独立成页（IA 修正：原埋设置子区会埋没连接状态/测试反馈）
  - i18n：独立 `mcp` 命名空间（`locales/{zh-CN,en}/mcp.json`），与 `registry` 同级；`common.pages.mcp` 导航标签；settings.json 的 mcp 段已删
  - 安全：P0 审批闸门复用（approvalMode='always' → onApprove 回调 → ApprovalCard）；ctx.signal 透传 client.callTool 支持取消
  - `web.ts` 搜索后端替换：Brave API（结构化 JSON 首选）> Jina Search > Bing HTML（降级 fallback）
  - 12 个 adapter 测试（注册/注销/AJV 校验/approvalMode/error 透传）；307 测试全绿，tsc 零错误
  - 代码 review 修复（2026-08-05）：
    - I4: `approvalMode='always'` 工具跳过自动重试（registry.ts — 用户批准的是一次特定调用，自动重试绕过审批闸门）
    - I1+I2: MCP teardown 统一（client.ts onclose 回调 → unregisterMcpTools；connectServer 先注销旧工具避免 hasTool 冲突 toolCount=0）
    - C1: 工具列表裁剪（`listBuiltinToolDefs()` 过滤 `mcp__` 前缀工具；首页/组队 agent 默认不暴露 MCP 工具，需显式注入）
    - I3: MCP 密钥走 vault（config.ts encryptSecrets/resolveSecrets/sanitizeConfig；env/headers 值存 safeStorage，配置文件只存 `vault:` 引用标记；listServers IPC 脱敏返回 `••••••••`）
    - M5: env scrub 增强（shell.ts `sanitizeEnv` 补 `_ID` 后缀）
    - M6: toolCtx 顺序修正（home.ts AbortController 在 toolCtx 之前创建，避免 TDZ 风险）
  - 复审收口（2026-08-05）：
    - R1: `orchestrate.ts` 与 home 对齐，不再 `listToolDefs()` 全量暴露
    - R2: `McpServerConfig.exposeToAgents`（默认 false）+ MCP 页开关；`listToolsForAgents()` = builtin + 已连接且勾选注入的 MCP
    - R3: `addMcpServer` / `updateMcpServer` 一律 `return sanitizeConfig(...)`
    - R4: registry/config 单测补 listAgentToolDefs、always 不重试、sanitize/resolve
- [ ] 7.3 即梦文生图 / chrome-devtools-mcp（Google 官方，替代 browser_use，走现有 MCP 客户端接入）/ desktop_screenshot 等外部工具
- [x] 7.4 Skill = ContextProvider（`beforeRun`/`afterRun`、discipline 注入、async 脚本 spawn）✅ 2026-08-03
  - `skills/provider.ts`：`SkillContextProvider.beforeRun`（<skill> XML 块 24000 限长 + scripts 清单行 + `【输出纪律】`discipline 段，三处调用点统一收口：编辑器编排 / 首页主 Agent / **首页组队图节点（此前完全没注入 skill，顺带补齐 outputConstraints 注入对齐）**）；`afterRun` 运行结束审计（orchestrate/home 两侧 finally 统一调）
  - `tools/builtin/skillScript.ts`：`skill_run_script` 全局工具——按 id/name 解析技能 → 路径安全（拒绝对路径/`..` 穿越，resolveScriptsDir 向上定位 scripts/ 祖先）→ 解释器路由（.py→python3 / .sh→bash / .js→ELECTRON_RUN_AS_NODE）→ **async spawn**（铁律23：Promise 化 + 60s SIGKILL + AbortSignal 联动 + stdout 256KB 上限 + stderr 尾 4K + 16K 输出截断，纪律复用 opencli_run）；cwd=技能根目录可相对读 resources/
  - 旧 `orchestrator/home.ts buildSkillBlocks` 删除；provider.test.ts 12 例 + skillScript.test.ts 7 例；typecheck + 256 测试全绿
- [x] 7.5 向量知识库 P0 地基（[`docs/VECTOR_KB_PLAN.md`](./docs/VECTOR_KB_PLAN.md) P0）✅ 2026-08-19
  - **决策**：推理 worker = `child_process` + `ELECTRON_RUN_AS_NODE`（铁律23 同类，非 worker_threads）；模型分发 = full（随包带模型）+ slim（运行时下载 hf-mirror）两种包；backend = `onnxruntime-web` (WASM) 全平台通用（不用 `onnxruntime-node`——npm 包只 ship darwin/arm64，Intel Mac 无二进制；WASM 零原生编译零 electron-rebuild，darwin/x64 实测通过）
  - **transformers.js v4 WASM-in-Node 配方**（实测验证，存记忆 `[[transformers-v4-wasm-node-recipe]]`）：`require(onnxruntime-web)` 设 wasmPaths+proxy=false → `globalThis[Symbol.for('onnxruntime')]=ort` 注入 → `require(transformers.web.js 绝对路径)` 绕 exports node 条件 → `useCustomCache=true` + customCache match+put 喂模型到磁盘 → `AutoTokenizer` + 手动 `InferenceSession` + mean-pool + L2 norm（绕 pipeline device-dispatch 空支持 devices）
  - **schema**：db.ts v10 migration（`kb_chunks` 含 vec BLOB NULL-able + vec_dim + meta + UNIQUE(doc_id,chunk_idx) / `kb_chunks_fts` 双列 content_tokenized+content_raw UNINDEXED / `kb_docs`）+ 启动自检（FTS 行数一致性 → reindexKbFts；vec_dim 多值/单值漂移 → app_meta `kb_reindex_required=1`）
  - **核心模块**（`src/main/vector/`）：`embed.ts`（EmbeddingProvider 接口 + LocalProvider facade + `getKbStatus` + `initKbStatus` + `checkVecDimDrift`）/ `worker-embed.cjs`（推理 worker，配方编码，stdio JSON 行协议，pending 计数防 EOF 竞态）/ `worker-client.ts`（spawn 管道，复刻 skillScript 纪律 + 持久单 worker + 64MB stdout cap + 120s 超时 + 失败返 null 降级不抛）/ `store.ts`（vecToBlob/blobToVec byteOffset 安全 + insertKbChunks 双写事务 + 幂等重摄取）/ `flat-index.ts`（Float32Array 拼接 cosine 点积 + HARD_CAP 20000 + 超 cap 分片/降级 + invalidate 重载）/ `kb-fts.ts`（reindexKbFts 镜像 reindexL3Fts）/ `rrf.ts`（倒数排名融合 k=60，NULL-vec 块单路仍参与排名）
  - **IPC 接线**：`ipc/knowledge.ts`（`kb:status` → `getKbStatus`）+ ipc/index.ts 注册 + preload OneApi `kb.status` 白名单 + index.ts `void initKbStatus()`（whenReady 后非阻塞）+ `before-quit` `terminateEmbedWorker()`（closeDb 前 best-effort）
  - **打包**：`electron-builder.slim.yml`（worker 脚本 + onnxruntime-web/common + transformers.web.js + jinja/tokenizers 随包 ship，绝对路径 require）+ `electron-builder.full.yml`（+ build/kb-models 预置模型）+ `scripts/fetch-kb-model.mjs`（hf-mirror 下载量化 onnx+tokenizer，幂等缓存）+ package.json `package:full`/`package:slim`/`kb:spike` 脚本
  - **测试**：v10.test.ts（建表+UNIQUE+双列 FTS+vec NULL）/ store.test.ts（BLOB 往返含 byteOffset + 双写 FTS MATCH + 幂等重摄取 + vec=null）/ flat-index.test.ts（Top1 score≈1.0 + 排序 + 空库 + 维度漂移 degraded + 分片注入测真实 searchSharded + invalidate）/ rrf.test.ts（两路融合+去重+k=60+NULL 公平+topN）—— **4 文件 23 例全绿**，全套 627 测试绿，typecheck 绿
  - **中文质量 spike**（`scripts/kb-spike.mjs`）：可跑骨架 ✅；22 query×66 skill 语料实测——`all-MiniLM-L6-v2`（英文）0%（预期，证模型选型关键），`multilingual-e5-small`（中文，query:/passage: 非对称前缀）Primary Top1 36.4% / Relaxed Top3 50%，**低于 FTS 词法 77.3%/90.9%**——证 skill 匹配场景 FTS 精确词命中仍胜向量，向量应作 RRF 混合补强而非替代（P2 hybrid 决策依据）。P1 出全量结果 + 质量判定
- [x] 7.5 向量知识库 P1 摄取管线（[`docs/VECTOR_KB_PLAN.md`](./docs/VECTOR_KB_PLAN.md) §五/§七/§八 P1）✅ 2026-08-20
  - **schema**：db.ts v11 migration——`kb_docs` 加 `content TEXT` 列存完整原文（换分块策略/模型可重切不丢文档；`kb_chunks.content` 是片段拿不回原文）
  - **分块**（`pipeline.ts` `chunkDocument`）：YAML frontmatter 剥离（解析 title/tags 进 meta，不入分块正文）→ 任意 `#` 标题切段（sectionTitle 记最近标题，fence 内的 `#` 不当标题）→ 超 512 token 二次切（按行推进 + 单行超长 fallback 按 Unicode 码点切，带 64 overlap 回退）→ code fence 守卫（截断点在 ```/~~~ fence 内则前进到 fence 关闭行，不拦腰截断代码块）→ 空文档早返不写空 doc；token 计数复用 `approxTokenCount`（非 tiktoken）
  - **摄取**（`pipeline.ts` `ingestDocument`）：chunk → 探 `getLocalProvider().ready()`（不 spawn）→ ready 则 `embed(texts, signal, 'passage')`（e5 非对称 ingestion 传 passage），未就绪全 null 降级（content+FTS 照写，vec=NULL 待 P4 reindex 补齐）→ `insertKbChunks`（chunks+fts 双写+幂等删旧）+ `upsertKbDoc`（含 content 列 + embeddingProvider=KB_MODEL_ID）；docId 传则覆盖重摄取；**绝不抛**（embed 失败 worker-client 已 catch 成 null，分块异常兜底单块整文 meta 标 fallback）
  - **store.ts 重构**：删 `insertKbChunks` 内 prepared-but-unrun 的 `upsertDoc`（latent inconsistency 消除——chunks+fts 双写职责单一，`kb_docs` 由 pipeline 显式调 `upsertKbDoc` 写）；`KbDocRecord` 加 `content?`；新增 `listKbDocsLite`（不含 content，避免大原文过 IPC）
  - **IPC**（`ipc/knowledge.ts`）：`kb:add`（Zod 校验 `KbAddSchema`，ZodError 转 `IpcErrorThrow('errors:kb.invalid_input')` 带 i18n key；空 content → `errors:kb.empty_content`）+ `kb:list`（`listKbDocsLite`）+ `kb:remove`（Zod docId → `deleteKbDoc` 级联）；preload `OneApi.kb` 加 `add/list/remove` 白名单；`shared/types.ts` 加 `KbAddInput/KbAddResult/KbDocListItem` 接口 + `normalizeI18nKey` knownNs 加 `'kb'`
  - **i18n**（铁律 T2）：zh-CN/en `errors.json` 加 `kb` 块（invalid_input/empty_content/not_found/embed_unavailable），主进程错误带 `errors:kb.*` key 渲染层翻译，不硬编码中文
  - **测试**：pipeline.test.ts 9 例（空文档/frontmatter/多标题/超长二次切/code fence 守卫/ingest ready 两态/空 content 早返/幂等 docId）+ store.test.ts +2（upsertKbDoc content 往返 + listKbDocsLite 不含 content + 二次 upsert 覆盖）—— **76 文件 638 测试全绿**（+11），typecheck 绿，build 绿，preload CJS 产出，v11 migration 真机 smoke（加列+往返+幂等）通过
  - **不在 P1**（后置）：P2 `kb:search` hybrid（FTS+FlatIndex+RRF）+ `kb_search` 工具 + `/kb` 前端页；P4 reindex 执行（`listNullVecChunkIds` + `updateKbChunkVec` 批量补 + 进度回调）；P5 pdf/docx 摄取（P1 只 md/txt/json 纯文本）；P6 HNSW/sqlite-vec
- [x] 7.5 向量知识库 P2 检索闭环（[`docs/VECTOR_KB_PLAN.md`](./docs/VECTOR_KB_PLAN.md) §六/§七/§八 P2）✅ 2026-08-20
  - **主进程 hybrid 检索**（`vector/search.ts` NEW）：`searchKbHybrid(query, opts)` → embed query（e5 非对称 search 传 `'query'`，与 P1 ingestion `'passage'` 对称）→ 向量路 `searchKbVectors`（FlatIndex cosine）+ 词法路 `searchKbFts`（FTS5 BM25 + LIKE 兜底）→ `rrfFuseTopN` 融合两路 rankedChannel（k=60）→ `fetchKbChunksWithDoc` JOIN kb_chunks↔kb_docs 取 content+title+meta → 返回 `{hits, degraded}`；**绝不抛**降级链（provider 未就绪/embed 返回 null → degraded=true 纯词法；FTS 极端字符炸语法 try/catch 退 LIKE；两路空 → hits:[]）；NULL-vec 块只进 FTS 路（RRF 天然公平，缺项路不产生分值）；docIds 限定在非分片向量路也生效（flat-index searchFlat 不过滤 → fetch 后按 docIdSet 裁剪）
  - **FTS 查询**（`kb-fts.ts` `searchKbFts` NEW）：镜像 `l3.ts searchL3` FTS 路 + `buildMatchQuery`（tokenizeForFts bigram/word ≥2 → `"term"` OR 连接）；SQL `SELECT chunk_id FROM kb_chunks_fts WHERE kb_chunks_fts MATCH ? ORDER BY rank LIMIT ?`（docIds 用 json_each IN）；FTS 无命中退 `content_raw LIKE ? ESCAPE '\\'`（转义 %/_ 防通配符全表扫）；空查询早返 `[]`（防 LIKE '%%' 全匹配）；**`l3.ts` `buildMatchQuery`/`escapeLikePattern` 改 export 复用**（单一真相源，KB 与 L3 FTS5 同构）
  - **batch fetcher**（`store.ts` `fetchKbChunksWithDoc` NEW + `KbChunkWithDoc` 接口）：JOIN kb_chunks↔kb_docs 一次 IN 查询取 content+meta+title+sourcePath（vs 逐条 getKbChunk N 次往返 + 不带 doc 标题）；空 ids 返回 `[]` 不跑空 IN；JOIN 不命中的孤儿 chunk 排除
  - **IPC**（`ipc/knowledge.ts`）：`kb:search`（Zod `KbSearchSchema` 校验 query/k?/docIds?，ZodError → `errors:kb.invalid_input`，返回 `{hits, degraded}`）；preload `OneApi.kb.search` + `shared/types.ts` 加 `KbSearchHit/KbSearchInput/KbSearchResult`
  - **工具**（`tools/builtin/kbSearch.ts` NEW，镜像 `skillRag.ts`）：`kb_search`（zod query/k?/docIds?，approvalMode='auto' 只读自动批准，content 截断 2000 字喂 LLM，返回 degraded 让 LLM 知纯词法）；`index.ts` `registerKbSearchTools()` 注册（在 registerSkillRagTools 后）
  - **前端 /kb 页**（`pages/KbPage.tsx` NEW，模板 SkillsPage+McpSettings）：embedding 状态条（`useKbStatus` ready/missing+维度+分块数，missing 显示纯词法 badge + P4 模型下载占位 disabled）+ 检索预览框（`useKbSearch` 输入查询→返回 content 片段+score+来源+章节，degraded 显示「纯词法」badge）+ 文档卡片网格（`useKbDocs` title+chunks+provider+sourceKind+updatedAt，删除 `useKbRemove` confirmDialog）+ 添加抽屉（title+content+sourceKind+sourcePath → `useKbAdd`）；路由 `/kb` + nav `BookOpen`（AppShell navItems，mcp 后）+ `kb.json` namespace（zh-CN/en，title/subtitle/status/search/add/doc/empty）wire `i18n/index.ts` + `common.json` pages.kb
  - **hooks**（`api/hooks.ts`）：`useKbStatus/useKbDocs/useKbAdd/useKbRemove/useKbSearch`（thenUnwrap + invalidateQueries ['kb']）
  - **测试**：search.test.ts 8 例（两路融合+ready/not ready 降级+embed null 降级+空查询+NULL-vec 只进 FTS+docIds 限定）+ kb-fts.test.ts 8 例（MATCH 中文/英文+LIKE 兜底+docIds 过滤+极端字符不崩+空查询+limit 截断）+ store.test.ts +3（fetchKbChunksWithDoc JOIN 取标题+空 ids+孤儿 chunk 排除）—— **78 文件 656 测试全绿**（+18），typecheck 绿，build 绿（KbPage 17kB chunk），preload CJS 产出含 kb:search 通道，main CJS 含 searchKbHybrid/kb_search/registerKbSearchTools
  - **P2+ 优化项（非阻断，2026-08-20 review 发现）**：
    - 向量 search 在主线程同步全扫（`searchFlat` O(n·dim)，单次 ms 级）；groupchat 多 agent 并发调 `kb_search` 轻度串行化主线程——铁律7 同类问题，但量级小几个数量级，不阻塞验收
    - 向量路 ready+embed 成功但 0 候选（`flat-index` 空）时 `searchKbHybrid` 返回 `degraded=false`（标「混合」非「纯词法」），轻微不精确——建议「本应参与却 0 候选」时标 degraded
    - 非分片态 docIds 限定：向量路全扫不过滤、靠 fetch 后裁剪，跨 docIds 强向量候选可能占 RRF rank 后被裁（sharded 态 >HARD_CAP 正确按 docIds 扫分片，属边界）
    - 前端 `searchMut` 的 `k` 写死 5（KbPage.tsx:90），未暴露调节 UI（与 IPC max(50)/工具 max(20) 不冲突，非 bug）
  - **不在 P2**（后置）：P3 L3/skills 检索加向量召回（先零成本调权重复测）；P4 reindex 执行 + 远程 OpenAI provider + Provider 切换触发重嵌 + /kb 模型下载按钮接通；P5 pdf/docx/URL 摄取 + 评测；P6 HNSW/sqlite-vec
- [x] 7.5 向量知识库 P4 reindex 执行 + 远程 OpenAI provider + 模型下载（[`docs/VECTOR_KB_PLAN.md`](./docs/VECTOR_KB_PLAN.md) §四/§八 P4）✅ 2026-08-20
  - **决策**：远程 provider **复用现有 Provider 抽象**（`ProviderModels` 加 `embedding?` 槽，复用 `Provider.keyId` + vault `getKey` + Settings→Providers 配置 UI），/kb 页只加 provider 选择下拉（不做独立配置表单）；对齐 §二:58
  - **类型**（`shared/types.ts`）：`ProviderModels.embedding?`（注释 `resolveModelIdByUsage` 未配会回退 default 聊天模型，故 `getActiveProvider` 须先判此槽存在）；`KbStatus` 加 `reindexRequired/activeProviderId/embeddingModel`，`embedding` 联合加 `'config-error'`；新 `KbReindexProgressEvent`/`KbReindexResult`/`KbProviderPreference`/`KbDownloadModelProgressEvent`；config.ts zod `models.embedding` optional
  - **存储**（`storage/`）：`db.ts` 导出 `getAppMeta`/`setAppMeta`（原私有，3 处内联副本改调）；`paths.ts` 加 `getBuiltinKbModelDir()`（packaged→resourcesPath/kb-models，dev→build/kb-models）；`builtin.ts` 加 `seedKbModel()`（full 包首启复制 resources/kb-models→userData/kb-models，仅在目标无 .onnx 时复制，slim no-op），`index.ts` `seedBuiltinAssets()` 后调
  - **store 原语**（`vector/store.ts`）：`clearAllKbVecs()`（UPDATE vec=NULL WHERE vec IS NOT NULL + flatIndex.invalidate，破坏性但 NULL-vec 仍走 FTS 降级，reindex 可重跑）+ `updateKbChunkVecBatch(updates)`（事务批量 UPDATE，不逐条 invalidate）+ `updateKbDocsEmbeddingProvider(provider)`（回标 kb_docs）
  - **RemoteEmbeddingProvider**（`embed.ts`）：bare `fetch` POST `${baseURL}/embeddings`（网络 I/O 非阻塞，不走 worker）；`ready()`=配置检查（不网络探测，镜像 local no-spawn 哲学）；`dimension()`=静态查表 `KNOWN_REMOTE_DIMS`（3-small=1536/3-large=3072/ada-002=1536）→ `app_meta kb_remote_dim:<modelId>` 缓存 → 未知返 0（`checkVecDimDrift` 跳过，首 embed 后回填）；auth header 镜像 openai-client（x-api-key vs Bearer）；HTTP 错/异常→全 null 降级不抛；首成功 embed 回填 dim 到 app_meta；OpenAI 3-* 返回已 L2 归一化，客户端不再归一化
  - **getActiveProvider/setActiveProvider**（`embed.ts`）：`getActiveProvider()` 读 `app_meta kb_embedding_provider_id`，**先判 `provider.models.embedding` 存在**（避开 `resolveModelIdByUsage` 回退 default 聊天模型）+ `provider.keyId` + `getKey` 有值 → 构造 RemoteProvider，否则降级 local；**不缓存 RemoteProvider**（用户 Settings 改 key 后缓存实例持旧 apiKey 风险，每次重构造开销小）；`setActiveProvider(id|null)` 写 app_meta + 标 `kb_reindex_required=1`（向量空间可能变 384↔1536）；`getKbStatus()` 分支 remote+ready→ready/remote、remote+未配→config-error/none、local 两态；`checkVecDimDrift()` 比较对象从 `DEFAULT_MODEL_DIM` 改 `getActiveProvider().dimension()`，dim===0 跳过
  - **reindex 循环**（`vector/reindex.ts` NEW）：`runReindex()` 统一 NULL backfill + 全量重嵌——`kb_reindex_required=1` → `clearAllKbVecs()`（旧维度向量全置 NULL）→ `listNullVecChunkIds` 覆盖全部 → 同一 backfill 路径（无 reindexRequired 则只补 NULL 增量）；BATCH_SIZE=32，kind='passage'，`updateKbChunkVecBatch` 落库；清标志 + `updateKbDocsEmbeddingProvider` 回标 + `flatIndex.invalidate()`+`initFlatIndex()` warm；provider 未就绪 → `IpcErrorThrow('errors:kb.provider_not_ready')`（try/catch 前抛，reject 即信号）；进度流 `kb:reindex:progress`（progress/done/error）镜像 `orchestrate.ts:56-63`（getMainWindow+emitProgress 闭包，webContents.send 单向推，与 withHandler 返回值解耦）；`cancelReindex()` AbortController 翻转
  - **模型下载**（`vector/download-model.ts` NEW）：复制 `scripts/fetch-kb-model.mjs` 逻辑到 `getKbModelDir()`（运行时可写，非 build 期）；`Xenova/multilingual-e5-small` + hf-mirror.com + 7 文件；幂等（跳过已存在非空）+ 404 容忍（不同模型文件集不同）；`Readable.fromWeb(res.body)` + `createWriteStream` pipeline（`as unknown as import('node:stream/web').ReadableStream` 断言避免 DOM/Node ReadableStream 冲突）；进度流 `kb:downloadModel:progress`
  - **IPC**（`ipc/knowledge.ts`）：`kb:reindex`/`kb:reindex:cancel`/`kb:downloadModel`/`kb:getProviderPreference`/`kb:setProviderPreference`（KbProviderPreferenceSchema zod 校验）5 handler；preload `OneApi.kb` 加 reindex/reindexCancel/onReindexProgress/downloadModel/onDownloadModelProgress/getProviderPreference/setProviderPreference（onXxx 返回 cleanup，镜像 orchestrate.onStream）
  - **调用点重路由**：`search.ts`/`pipeline.ts` `getLocalProvider`→`getActiveProvider`（import + 用法）
  - **前端 /kb 页**（`pages/KbPage.tsx`）：状态条加——下载按钮（`embedding==='missing'` 时，`useKbDownloadModel` + `useKbDownloadModelProgress` 进度条）+ provider 下拉（原生 `<select>`，`useProviders` 过滤 `p.models.embedding` 存在，onChange `useKbSetProviderPreference({providerId|null})`，「本地（默认）」对应 null）+ reindex 按钮（`status.reindexRequired` 时，`useKbReindex` + `useKbReindexProgress` 进度条）+ reindexRequired/configError badge + remote 状态文案；hooks 6 新（`useKbReindex`/`useKbDownloadModel`/`useKbProviderPreference`/`useKbSetProviderPreference`/`useKbReindexProgress`/`useKbDownloadModelProgress`，后两 useEffect 订阅）
  - **i18n**（`kb.json` zh-CN/en）：`status.{remote,configError,reindexRequired,downloading}` + `provider.{label,local,selectHint}` + `download.{button,downloading,done,failed}` + `reindex.{button,running,done,failed}`；`errors.json` kb 加 `provider_not_ready`/`model_not_found`（铁律 T2 主进程结构化错误 key）
  - **测试**：reindex.test.ts 5 例（全量重嵌 clearAllKbVecs+回标 / 增量只补 NULL / 无 NULL 零计数 done / 进度单调 / 未就绪 throw 不调 embed）+ remote-provider.test.ts 16 例（ready 四态 / dimension 查表+未知 / embed POST body+Bearer+x-api-key+HTTP 错全 null+网络异常全 null+首 embed 回填 dim+空数组 / getActiveProvider 选择四态 / getKbStatus 分支）；search.test.ts+pipeline.test.ts mock `getLocalProvider`→`getActiveProvider` —— **80 文件 677 测试全绿**（+21），typecheck 绿，build 绿（KbPage 24kB chunk）
  - **不在 P4**（后置，部分已补做见下）：P3 L3/skills 检索加向量召回（前置重调 ✅ 见下，向量本身暂缓）；P5 pdf/docx/URL 摄取（✅ 见下）；P6 HNSW/sqlite-vec（换 FlatIndex，接口不变）

- [x] 7.5 向量知识库 P5 pdf/docx/URL 摄取（[`docs/VECTOR_KB_PLAN.md`](./docs/VECTOR_KB_PLAN.md) §八 P5）✅ 2026-08-20
  - **依赖**：`unpdf`（PDF，纯 JS PDF.js build）+ `mammoth`（DOCX，流式 XML）—— 两纯 JS 无原生编译无 electron-rebuild；URL 复用 Jina Reader `r.jina.ai` 范式（无新依赖）。`package.json` 加两 deps + `kb:eval` script
  - **抽取模块**（`vector/extract.ts` NEW）：`extractFromFile(path)` 懒 `await import('unpdf')`→`extractText(buf,{mergePages:false})` 每页插 `# Page N` heading（喂 `chunkDocument` `#`-splitter 产出 per-page sectionTitle）；`mammoth.convertToHtml`→手写 `htmlToMarkdown`（h1-h6/ul/ol/a/strong/em/code/pre，~40 行，不引 turndown）；txt/md 原文；html→`htmlToMarkdown`。`extractFromUrl` fetch `https://r.jina.ai/${url}`（镜像 web.ts fetchText：UA+30s 超时+AbortController+12000 字 cap+可选 `process.env.JINA_API_KEY` Bearer）。MAX_FILE_BYTES=20MB guard。`ExtractedDoc{content,title?,sourceKind}`。全 `IpcErrorThrow('errors:kb.*')` 无硬编码中文
  - **IPC**（`ipc/knowledge.ts`）：新 `kb:pickFile`（`dialog.showOpenDialog` pdf/docx/txt/md/html/htm，cancel→null，extract→ingest，防御性 `deleteKbDoc(createdDocId)` 回滚）；`kb:add` 加 `url` 分支（content-XOR-url 校验：两者都有→`errors:kb.invalid_input`，都空→`errors:kb.empty_content`，url→`extractFromUrl`→ingest sourceKind:'url'）
  - **类型/preload/hooks/UI**：`KbAddInput.url?` + `content?` 改 optional（handler 强制 XOR）；preload `kb.pickFile`（impl + `OneApi` 接口）；`useKbPickFile`（invalidates docs+status）；KbPage Add drawer 加「选择文件」按钮（FileUp）+ URL 抓取行（Globe）+ sourceKind 改 `<select>`（md/txt/pdf/docx/url）+ `hostnameOf` helper。渲染层零 Node（文件读/抽取只在主进程 kb:pickFile）
  - **i18n**（T2）：`kb.json` add.{pickFile,pickFilePending,pickFileHint,urlField,urlPh,fetchUrl}；`errors.json` kb.{extract_failed,unsupported_file_type,url_fetch_failed,empty_extraction,file_too_large}（主进程结构化错误 key）
  - **测试**：extract.test.ts 35 例（mock unpdf/mammoth/fetch/fs：PDF 页 heading 发射/空抽取→`errors:kb.empty_extraction`/unpdf 抛→`errors:kb.extract_failed`/DOCX→htmlToMarkdown/txt/md/不支持类型→`errors:kb.unsupported_file_type`/size guard→`errors:kb.file_too_large`/stat 失败/URL fetch title+hostname+HTTP 错+网络异常+非 http+空+JINA_API_KEY header/htmlToMarkdown 单元）；pipeline.test.ts 加「P5 heading 发射→chunk meta.sectionTitle 收 Page 标题」例
  - **不在 P5**（后置）：worker-extract（主进程内抽取量级够轻，加 size guard；profiling 证 >5s 阻塞主循环再起 `worker-extract.cjs` 镜像 worker-client spawn 纪律）

- [x] 7.5 向量知识库 P3 前置（searchSkills 排序重调 + 22 条评测 + go/no-go 决策）✅ 2026-08-20
  - **重调杠杆**（三档，计划 B1）：① name/tag 通道改 token 子串匹配（复用 `l3.ts` 新 export `buildMatchTerms`）② FTS5 `bm25()` 列加权（name=10/desc=3/tags=4/content_tokenized=1/content_raw=0.1）③ LIKE 通道 `escapeLikePattern` 修 latent 通配符注入 bug（`l3.ts` 已在 L3/kb-fts 修，skills fts.ts 漏）+ `buildMatchQuery` DRY 复用 `l3.ts`（词提取单一真相源）
  - **评测**（`scripts/skill-rag-eval.mjs` 镜像生产 + `npm run kb:eval`）：同 **66-skill 当前池**受控 A/B（旧 77.3% 是 65-skill 旧池旧命名，不可比）——原 ranking Primary Top1 **59.1%** / 全量重调 **45.5%**（**回归 -13.6pp**）/ bm25 列权降回 `ORDER BY rank` 50.0% / **escape-only 59.1%**（行为中性）。病根：token name 通道 + bm25 name 列权 10 过度加权 **CJK 命名「…纪律」类 skill**（name 含 query bigram 如「选题调研纪律」含「选题」「调研」）拿 3.0 name 权 + bm25 name 列高分，压过 **ASCII 名真目标**（tech-research/md2wechat/skill-creator 与 CJK query 零 token 共享，只在 content 列有分）
  - **决策**（安全门「Top1 ≥ before 且失败改善」）：保留原 ranking + 只留 latent bug 修（escape）+ DRY。token/bm25 杠杆均回归 Primary Top1，不符安全门，回退。回归门 `search-skills.test.ts`（import **生产** searchSkills，drift-free）9 例锁 escape latent-bug 修（含 `%`/`_` query 不抛不全表噪声）+ 原排名不回归（#4/#5/#1/#2/#3/lark-doc/wechat-tech-content 仍命中）
  - **go/no-go**：retuned FTS Top1 **59.1%** vs vector baseline（`kb-spike.mjs` multilingual-e5-small）**36.4%** / Relaxed Top3 **50%**——词法仍显著超向量 → **P3（给 skills 搜索加向量）暂缓**。真实瓶颈是 CJK 命名 vs ASCII 命名 ranking 冲突，非词法 vs 向量（向量对短 name 同样弱，见 P0 spike）。后续优先级：① skill 命名规范化 ② 主 agent 端到端跑批 ③ 再考虑向量。详见 [`docs/SKILL_RAG_EVAL.md`](./docs/SKILL_RAG_EVAL.md)「重调结果（2026-08-20，P3 前置）」段
  - **范围确认**：无 `skills_vec` 迁移、无 sidecar 表、无 hybrid skills 搜索代码（`grep "skills.*vec" src/main/storage/db.ts` 仅 `app_meta` 行）

---

## 阶段 8：Registry 共享（进行中）

> 方案文档：[`docs/REGISTRY_PLAN.md`](./docs/REGISTRY_PLAN.md)（2026-08-02 可行性修订版）。
> 动工前必须先落 §2 provenance schema（三实体 `registry` 字段 + Zod），这是级联导入/更新检测的地基。

- [x] 8.1 one-registry 仓库 + 分支保护 + manifest zod schema + validate/reindex CI（Phase 1）✅ 2026-08-03
  - 仓库上线：[shijianzhong/one-registry](https://github.com/shijianzhong/one-registry)（本地 `~/sking/one-registry/`）；README（贡献指南+审核标准）/LICENSE/build-index.mjs/validate.mjs（slug 跨类型唯一 + 依赖完整性 + version 递增检查）/validate+reindex workflows
  - 三条官方示例资产：web-research 技能（含 Discipline 段）/ web-researcher 角色 / quick-research 能力；reindex CI 首次 push 已自动重建 index.json
  - 分支保护：必走 PR（0 审批可自合）+ validate `check` 必过 + 禁 force push/删除；enforce_admins=false（保留 owner 紧急通道）
  - 双源实测可达：raw.githubusercontent.com + cdn.jsdelivr.net 均正常返回 index.json，skill.zip 可下载（SKILL.md 在 zip 根，符合 parseSkillZip 约定）
- [x] 8.2 provenance 字段（Agent/Skill/Capability + config.ts）+ Registry 数据层（多源 fallback）+ 浏览/详情页 + 三条导入链路（slug→本地 id 重映射 / modelId 置空回退 / 含脚本确认框）+ parseSkillZip discipline 提取（frontmatter 优先，回退 `## Discipline` 段落）（Phase 2）✅ 2026-08-02
  - provenance：三实体 `registry?: RegistryProvenance`（types.ts + config.ts zod）；save* 编辑保存不带 registry 时保留既有溯源；saveSkill 顺带修 discipline 编辑误清
  - 数据层 `src/main/registry/`：sources（源抽象 + token 仅发 GitHub 系域名 + slug 校验防路径穿越）/ client（多源 fallback + 8s 超时 + vault token）/ service（index 10min 内存缓存 + 持久缓存 stale 回退；manifest 缓存；skill.zip 5min 复用）/ schemas（远端数据 zod 校验）/ remap（图重映射纯函数）/ importer（plan/apply 两段式，级联依赖，同版本跳过）
  - IPC `registry:*`（getConfig/getIndex/getManifest/planImport/applyImport）+ preload 白名单
  - 渲染层 `/registry` 页：类型过滤 + 搜索 + 已安装/有更新徽标（index version 比对 provenance）+ 详情抽屉 + 导入计划确认（脚本文件名警告 + capability「仅导入图」勾选）；`registry` i18n namespace 双语
  - discipline：parseSkillZip 提取（frontmatter 优先回退 `## Discipline` 段，content 不剥离——7.4 前 content 是唯一注入载体）；skills:pickFile 透传 + SkillsPage 上传落盘
  - 单测：upload.test.ts（discipline 4+3 例）/ remap.test.ts（6 例）/ sources.test.ts（URL 拼装/token 域名/slug 校验）；typecheck + 226 测试全绿
  - Phase 2 review 修复（2026-08-03，REGISTRY_PLAN §10）：① 更新/删除 skill 清理旧 `skl_upload_` 解压目录（`getSkillUploadTempDir` 前缀守卫防误删）② 本地修改冲突检测（`isLocallyModified`，save* 注入统一 now 使 importedAt==updatedAt 防误判；级联保留本地版，顶层跳过报 `locally_modified` + i18n 提示）③ plan 阶段 zip 解析容错不阻断 ④ remap 空数组注释 + RegistryPage 按 kind 收窄去交叉断言
- [x] 8.3 导出三链路（skillIds slug 化 / modelHint 转换 / skill 按 scriptPath 重组 zip）+ 推送预览清单 + PR 引导 + provenance 回写（Phase 3）✅ 2026-08-03
  - 序列化纯函数 `registry/serialize.ts`（不依赖 electron 可单测）：slugify / bumpPatch / agent（skillIds→slug + modelHint 取 ModelConfig.modelId + 剥离本地字段）/ skill（SKILL.md 重组，discipline 字段有而 content 缺段时补 `## Discipline` 段）/ capability（图节点 slug 化 + 剥 modelId + dependencies 自动推导，sourceAgentId 空的手动节点不产依赖）
  - 编排 `registry/exporter.ts`：planExport 级联收集（skill 仅自身 / agent+其 skills / capability+图引用 skills+sourceAgentId 物化 agents，去重 + dangling 告警）；applyExport 本地预检（slug 合法+跨类型唯一+semver，对齐 validate CI）→ skill.zip 重组（SKILL.md 根 + scriptPath 反查 skl_upload_ 目录的 scripts/resources 等）→ writeJsonFile 落盘所选目录 `one-registry-export/` → 三类 save* 回写 provenance（统一 now）
  - IPC `registry:planExport/applyExport/openContribute`（applyExport 弹目录选择器，取消返 null，成功 shell.showItemInFolder）+ preload 白名单
  - 渲染层 `components/RegistryPublish.tsx` 自包含发布按钮 + Drawer 预览清单（slug/version 可编辑 / 依赖取消勾选剔除 / 新增·更新·自动附带徽标 / dangling 警告），接入 Skills/Agents/Capabilities 三页操作区（能力页 stopPropagation 防卡片跳转）；`registry.publish.*` i18n 双语
  - 单测 serialize.test.ts 12 例；typecheck + 238 测试全绿；导出格式逐条对照 one-registry validate.mjs 规则核验（id==目录名 / slug 正则同源 / semver / skillZip 存在 / 依赖完整性）
- [x] 8.4 设置页 Registry 区（Token 存 vault + 源列表管理）+ 403 分场景引导（Phase 4）✅ 2026-08-03
  - `REGISTRY_TOKEN_KEY_ID`/`DEFAULT_REGISTRY_SOURCES` 收口 shared/types；`registry:saveConfig` IPC 主进程校验（repo owner/name 格式 + 源模板 https+`{path}` 占位 + id 去重）+ `resetRegistryCaches` 失效
  - 设置页 `RegistrySettings` 组件：Token 状态徽标 + 存 vault 不回显（复用 secrets:* 通用 keyId 通道）+ 只读/写 PR 分场景权限文案（§4.3 表）；repo/ref 编辑；源列表优先级上下移/删除/追加/重置默认
  - 403 引导：client 全源失败且任一 http_403 → `registry_rate_limited` 错误码；RegistryPage 识别渲染限流引导条（60/h→5000/h 文案 + 去配置按钮跳设置页）
- [x] Phase 5 体验优化 ✅ 2026-08-03
  - **自动 PR（方式 B）**：`registry/publisher.ts` GitHub API——`/user` → forks 幂等 + 轮询等建仓 → publish/<slug>-<ts> 分支 → Contents API 逐文件提交（已存在带 sha 覆盖，zip base64）→ 上游 PR（422 回退捞已有 open PR）；错误分场景（401/403 权限/404/rate limit）抛中文引导；导出成功视图「自动提交 PR」按钮（成功自动 openExternal PR 页）
  - **star 统计**：`registry:getRepoStats`（匿名 60/h，有 token 自动附带）→ RegistryPage 头部 star 徽标（失败静默不阻断）
  - **一键更新**：卡片「有更新」旁快捷按钮——plan 无脚本直接 apply；含脚本回落详情抽屉确认；结果轻量状态条反馈（resultSummary 抽取共用）
- [x] Registry 二轮 review 修复（docs/REGISTRY_REVIEW_ISSUES.md）✅ 2026-08-03
  - **P1 spread 回写**：exporter 三处 save* 改 `{...entity, registry}`——顺带修 live bug：`Agent.source` 曾未枚举且 `saveAgent` 不回退 existing，导出内置 agent 把 `builtin` 洗成 `custom`
  - **P1 waitForkReady**：401/403/429 即抛（404 = fork 建仓窗口期继续轮询），超时错误附最后错误摘要
  - **P2 YAML 转义配套**：导出 `yamlSafe()`（name/description 特殊字符双引号包裹）+ `parseFrontmatter` 双引号值反转义，导出→导入回环保真；dropped 列表去重；PR 分支名秒级精度防同分钟 422
  - **定性修正**：「批量更新缺失」改判为设计外增强（§3.4 一键更新定义的就是单项重导入，已实现）；权衡表 `writeJsonFile` 同步条删除（json-store 同步是全项目既定模式）；「错误分类」移出通过项（toGhMessage 硬编码中文属 T2 errors.* 已知缺口）
- [x] slug 分配必修（P3#8 升级，用户首用实撞 `agent-msd1ciya` 全撞）✅ 2026-08-03
  - `allocSlug` 兜底链：slugify(name) → slugify（本地 id 去类型前缀）（中文名得语义 slug：`agt_content_review`→`content-review`）→ kind-时间戳-4位随机hex；冲突避让 `-kind` → `-2/-3`；taken 跨类型对齐 CI 全局唯一
  - 两阶段分配：provenance slug 先占位再分 fallback，消除图遍历顺序依赖；exporter.test.ts +3 例（9 资产唯一语义化/随机后缀互异/provenance 避让）

---

## 已知缺口（优先战场，2026-08-01）

按产品闭环与保真风险排序，勿把「骨架已合」当成「里程碑已达」：

| 优先级 | 缺口 | 对应 |
|--------|------|------|
| ~~P0~~ | ~~runner `shouldRespond` 硬编码 true~~ ✅ `4dd76dc` | 铁律 15 / GroupChat 广播 |
| ~~P0~~ | ~~Concurrent fan-in 栅栏~~ ✅ `4dd76dc` | 4a.5 |
| ~~P1~~ | ~~GroupChat manager 运行时接线~~ ✅ `4dd76dc` | 4b.3 |
| ~~P1~~ | ~~`repair_tool_pairs`~~ ✅ `4dd76dc`；context_mode 完整三态（`full`/`last_agent`/`custom+context_filter`）Sequential 下游接入待联调 | 铁律 16/18 |
| ~~P0~~ | ~~首页直答 vs 组队 JSON 路由~~ ✅ `b192df4`（@芯片 + LLM 意图路由指令段 + 组队拼图跑 runner） | 铁律 24 |
| ~~P1~~ | ~~聊天创建能力/角色/Skill~~ ✅（propose_* 工具产草稿 → 前端确认卡可编辑 → 确认才入库；能力由 LLM 生成 graph JSON） | 主 Agent 创建闭环 |
| ~~P1~~ | ~~HITL 人机交互（ask_user）~~ ✅（`ask_user` 内置工具 + `userInput` 应答队列 + `request_info`/`request_resolved` 流事件 + `orchestrate:respond` IPC；home/编辑器同一队列；30min 超时转错误 JSON；取消/收尾驳回挂起；hitl.test.ts 全链路 + userInput 单测） | 编排 HITL |
| ~~P1~~ | ~~编辑器运行聊天化~~ ✅（右栏「属性/运行对话」tabs（可拖拽调宽 300–760，聊天 tab 自动放宽 520）+ RunChatPanel 取代运行弹窗；与首页 @能力 共用 ChatMessage/applyOrchEvent/MessageItem/AskUserCard/useSpeakerNames；**每次运行 = 新对话新 session**；试跑记录 capabilityId 关联、**不进主 Agent 会话列表**，在运行对话 tab 历史下拉回看（`?session=` 深链保留）；composer 发送/停止；画布节点高亮保留） | 编辑器 = 首页 @能力 |
| ~~P0~~ | ~~Concurrent 容器边 fan-out 时机错误~~ ✅（实测 bug：容器 handle 是纯分发瞬间完成，runner 立刻把**原始输入** fan-out 给下游 → 下游与 participant 同 superstep 并发开跑拿不到调研结果 + fan-in 栅栏二次触发。修复：Concurrent 容器禁边 fan-out，下游由栅栏等齐后统一投「任务前缀+聚合结果」（含容器其它下游边）；builder 边端点/aggregator 兼容角色库 id 解析；子节点 isEntry 徽章/勾选隐藏（运行期只认顶层）） | 铁律 7 / fan-in 栅栏 |
| ~~P0~~ | ~~Sequential full_conversation 保真 + 容器边界边死边~~ ✅（runner 边 fan-out 从「仅末条」改为 AgentExecutor 转发完整 cache（下游可见原始任务+全部上游产出），assembleMessages 合并连续同角色防 400；builder 改写 sequential 容器边界边（X→S⇒X→首 participant，S→Y⇒末→Y，条件保留）——此前容器出边是死边，流程断在容器边界） | 铁律 16 / §G |
| ~~P0~~ | ~~全应用无 Error Boundary（渲染异常 = 白屏）~~ ✅ 2026-08-01（`ErrorBoundary` 组件包 HashRouter 外层，降级 UI + 重载入口，common i18n key；reducer 对 `done` 也定格流式态作纵深防御） | 渲染层防御 |
| ~~P1~~ | ~~Concurrent fan-in participant 失败 → 栅栏永不满足静默提前收敛~~ ✅ 2026-08-01（`failedNodes` 记录失败 executor，栅栏容错聚合「成功结果 + 失败标注」；runner.test.ts 回归用例） | 4a.5 / runner.ts |
| ~~P1~~ | ~~WAL 备份只拷主库文件未 checkpoint（假备份）~~ ✅ 2026-08-01（`backupDatabase()` 先 `wal_checkpoint(TRUNCATE)` 合并 WAL 再拷贝，周期/退出共用） | 6.5 / db.ts |
| ~~P1~~ | ~~i18n 用户可见硬编码清零~~ ✅ 2026-08-01（EditorPage/AgentNodeView/ContainerNodeView/Agents/Skills/List/Settings 全量 key 化，+66 新 key（common/editor/settings 双语）；代码↔locale 交叉校验 187 引用零缺失，顺手补既有缺失 `editor:inspector.subtitle`；**errors.* 主进程 key 仍未齐**） | 5.8 / 铁律 T2 |
| ~~P1~~ | ~~file_* 工具同步 I/O 阻塞主进程~~ ✅ 2026-08-01（`fs/promises` 全量异步化，file_search 逐文件 await 不冻 UI；契约按 file.test.ts 7/7 还原：vault 围栏 / `ONE_FILE_ROOTS` 覆盖 / `path_not_allowed` / 文件名+内容 OR 匹配） | 7.1c |
| ~~P1~~ | ~~window.confirm / window.alert 原生弹窗~~ ✅ 2026-08-01（`ConfirmDialog` promise 式组件 + `ConfirmHost` 挂 App 根部；5 处 confirm 统一替换，SkillsPage 上传失败改内联错误条 + `skills.uploadFailed` key） | 渲染层规范 |
| ~~P2~~ | ~~CSS/主题硬编码~~ ✅ 2026-08-01（新增 `--color-on-brand` 令牌，app.css 7 处 white/#fff + Button 变体 text-white 统一替换；侧栏玻璃 `rgba(255,255,255,.52)` → `var(--glass-bg)` 并删 dark 覆写；`.side-list` 重复定义删旧；theme.ts 玻璃边 alpha 提命名常量） | DESIGN §2 / T 系 |
| ~~P2~~ | ~~主进程运行期加固批次~~ ✅ 2026-08-01（sessions IPC 全量 Zod 入参校验；retry sleep abort 监听器 once+正常到时清理；userInput 定时器 unref + pendingDrafts 100 上限；nativeTheme 防重复挂载；orchestrate skill 运行期磁盘缓存；runner `deliverToExecutor` 用 signal 提速取消 + 取消后禁 fan-out；Executor cache 软上限 200（保首条+最近 N）；`repairToolPairs` 降级空 content 占位文本 + 测试；frontmatter 解析器重写（重复行误判/`\|`vs`>`语义/行内注释）；背景图导入压缩 1920px/JPEG82 治 base64 过 IPC；theme store `subscribeSystemMode` cleanup 复位（HMR 监听丢失）；hashApiKey → sha256 96bit；`HANDOFF_TERMINATION`/`SequentialConfig` 死代码清理） | 主进程加固 |
| ~~P3~~ | ~~版本号 / 日期 locale 硬编码~~ ✅ 2026-08-01（SettingsPage 版本走 `system.ping` appVersion；TasksPage `Intl.DateTimeFormat` 走 `i18n.language`） | — |
| ~~P2~~ | ~~saveL3 主表 + FTS 无事务~~ ✅ 2026-08-01（`db.transaction` 包裹；removeL3/reindexL3Fts 同事务化） | 3.4 / l3.ts |
| ~~P2~~ | ~~opencli stdout/stderr 无界累积~~ ✅ 2026-08-01（stdout 256KB 上限 SIGKILL + stderr 末尾 8K 保留；超限结构化返回不走重试） | 7.1a |
| ~~P2~~ | ~~流式 `tool_use_*` delta ID 不一致~~ ✅ 2026-08-01（index→tool_use_id 映射表，start/delta/stop 全程真 id；text 块不再发伪 tool_use_stop；client.test.ts 3 case） | llm/client.ts |
| ~~P2~~ | ~~Skill ContextProvider + 脚本~~ ✅ 2026-08-03（provider 三处收口 + discipline 注入 + skill_run_script async spawn；首页组队节点补注入） | ~~7.4 / 铁律 22/23~~ |
| ~~P2~~ | ~~崩溃草稿写盘 + UI~~ 部分 ✅ 2026-08-08（首页 composer / 编辑器画布写盘；`propose_*` → `drafts/create-*.json` 水合 + `listPendingDrafts` 重挂确认卡；CrashRecovery 列表/复制/忽略。**仍缺**：输入框/画布一键自动灌回） | 6.4 / PROJECT_REVIEW |
| ~~P1~~ | ~~自由召唤协议批次~~ ✅ 2026-08-08（`@[kind:id]` token；能力真子图 `embedCapabilityGraph`；HITL `rejectUserInputsForRun`；`allowedToolNames` 白名单字段+运行时过滤；路由指令强化） | docs/PROJECT_REVIEW.md |
| P2 | 更多 builtin 工具 | 7.1 |
| P2 | external 插件分发入口缺失：加载链（`external-plugins/` → 注册 → /plugins 管理）已落地，但 `saveExternalPlugin` 无生产调用方——插件只能手工落盘；registry 分发/目录导入 IPC 待接 | 插件架构 external |
| ~~P3~~ | ~~AbortController 模块级单例~~ ✅ 2026-08-01（入口检测已有运行自动取消旧运行 + finally 只清自己句柄，home/orchestrate 双侧） | ipc/home / orchestrate |
| ~~P2~~ | ~~L3 向量检索后置~~ ✅ P0 地基 2026-08-19（[`docs/VECTOR_KB_PLAN.md`](./docs/VECTOR_KB_PLAN.md) P0） | L3 向量 |
| ~~P3~~ | ~~编排路径记忆注入~~ ✅ `71829e0`（orchestrate 注入 L0+L2，对齐首页）/ ~~编排路径 L2 写侧~~ ✅（orchestrate converged 收尾 `refineL2` 落 `memory_l2`，`makeCompressFn` 抽 `llm/compress.ts` 共用 + `toLlmMessages` 抽 `sessions.ts` 共用）/ ~~tasks 落盘~~ ✅（tasks 表 CRUD 已落地）/ win 包（配置在 electron-builder.yml + CI windows-latest，待真机验证） | M6 / M3 尾巴 |
| ~~**P0**~~ | ~~向量知识库第二轮深度 review~~ ✅ 2026-08-21（按代码事实复核后分级修正：原文档 6 个 P0 仅 #1 真阻塞，#19/#20 诊断不准已重新定性。落地：#1 flat-index search 惰性重载+degraded 语义；#3 非分片 docIds 过滤；#4 `ingestKbDocument` 单事务；#5 未闭合 fence 硬切；#6 worker init-promise 去重；#22 批超时杀 worker 自愈；#23 abort 监听全路径清理；#2 远程响应条数校验；#24 远程 60s 超时；#7 嵌套列表最内层迭代替换；#8 `providerTagFor` 统一口径；#13 下载/seed 原子 rename 防半截；#12 下载 5xx 退避重试；#15 单文件 200MB 上限；#14 前端四 handler 错误反馈；#17 providerError 独立；#19 真实问题修复（clearAll 后取消→标志保留+cancelled 事件）；#9 hasLocalModel 缓存+IPC 失效；#16 migration 幂等；#18/#21/#25 死代码；#26 LIKE 剩余配额；#10/#11 共享 `util/net.ts`+`util/html.ts`。不改：#20（db.ts 启动 DISTINCT 全扫已覆盖多维度）。新增回归测试 14 条，vitest 731 全绿 + tsc 干净） | 7.5 / vector/* |
| ~~P2~~ | ~~KB review 二轮补修（#16 升级 / #27 / 并发守卫）~~ ✅ 2026-08-21（用户复核点名：① #16 migration 改显式幂等——条目新增 `isApplied` 前置检查，v11 用 `pragma_table_info` 判列存在登记跳过，不把异常当控制流，`db.migration-v11.test.ts` 直测真实迁移链；② #27 原生对话框去硬编码中文——新增 `NativeFileDialogLabels`，`kb:pickFile`/`skills:pickFile` 文案由渲染层 i18n 经 IPC 传入（zod 校验），新增 `kb:picker.*`/`common:skills.picker.*`/`errors:skills.invalid_input` locale key；③ reindex/downloadModel 并发守卫——模块级 inflight promise，并发调用挂到在途任务拿同一结果，防双倍 embed/拉流 + clearAll 交错 + .part rename 竞态。新增回归测试 5 条，vitest 736 全绿 + tsc 干净） | db.ts / ipc / vector/* |
| ~~P3~~ | ~~插件架构 Stage 3：generated/B 代码型工具闭环~~ ✅ 2026-08-26（[`docs/PLUGIN_ARCHITECTURE.md`](./docs/PLUGIN_ARCHITECTURE.md) §3 B 层 + §5 Stage 3）。项目**首次引入沙箱执行**（全仓此前无 `node:vm` 先例）。`propose_generated_b` 工具 → `CreateConfirmCard`（handlerSource textarea）→ `home:confirmCreate` 走 `validateGeneratedBSpec` 闸门（handlerSource 非空 + vm 编译期验语法 + inputSchema 结构，失败抛 `IpcErrorThrow('errors:plugins.compile_failed')`）→ `saveGeneratedBPlugin`（manifest.json + handler.js）→ `enableBPlugin` 注册。**vm 沙箱**（`sandbox.ts`）：`vm.runInNewContext` 编译 handler 源码，context 只注入 `executeTool`（不暴露 require/process/global），`executeTool` 调白名单 8 动作（file_read/file_search/kb_search/web_search/glob/grep/skill_search/load_skill），白名单外返 `action_not_whitelisted`；`runBHandler` 用 Promise.race + AbortSignal 60s 超时 + 16KB 输出截断。**信任闸门三态**（`manifest.trustedBy`）：null→占位工具（approvalMode='auto' 返 `trusted_required` 提示）/ 非空→真 handler（approvalMode='always' 每次弹审批）/ 编译失败→不注册 emit failed。A/B 共用 `generated-plugins/` 目录根靠 id 前缀互斥（gen_ vs genb_ 正则过滤）。`plugins:trust` IPC + preload `trust(id,trust)` + `PluginsSettings` 信任按钮/徽标/handlerSource 源码展示。i18n errors.json +5 key / plugins.json +8 key / home.json +3 key（zh-CN/en 对齐）。`external` kind 仍后置。tsc 干净 / vitest 917 全绿 / build ✓） | 插件架构 Stage 3 |

> **2026-08-01 review 误报排除清单（已核实，勿再报）**：① JSON 配置（models/providers/persona）与 vault「读-改-写竞态」——读写全同步（`readFileSync`/`writeFileSync`），事件循环天然原子，加锁为空操作；② `selectSession(result.runId)`——`home:chat` 返回的 runId 按构造即 sessionId；③ `orch_event.done` 与 `message_stop` 间隙——主进程全路径（正常/异常/取消）均配对发送 message_stop（reducer 侧已补 `done` 定格流式态作纵深防御 ✅ 2026-08-01）；④ Magentic 直接 throw——MVP 既定降级设计。

> **2026-08-01 已核实为「设计取舍不改」清单**：① EditorPage 1666 行拆分——重构非缺陷，无 E2E 下回归风险大于收益；② builder.ts `as` 断言类型化——同重构；③ handoff 空 `input_schema` 兼容性——改动可能破坏现有 handoff 链路；④ GroupChat fairness 固定选择顺序——行为变更，源框架同款；⑤ `isTransient` 判定拓宽——误重试风险大于收益；⑥ HomePage 流式数组 / EditorPage onDrop 重建——无实测性能瓶颈的预防性优化，不改。
