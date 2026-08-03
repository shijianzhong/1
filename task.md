# One — 实施任务清单

> 依据 `docs/REWRITE_PLAN.md §八` 分阶段计划。每完成一项把 `[ ]` 改 `[x]`，并在行尾补 commit 短哈希 / 日期。
> **本文件是实现进度权威源**；`CLAUDE.md`「当前阶段」与 `REWRITE_PLAN` §八 应与此对齐。
> 阶段 0（脚手架）已完成于 `2f759db`（M0 骨架修复）。
>
> **快照 2026-08-01**：M0–M4 ✅ · M5 骨架 ✅（i18n 未清零）· M6 部分 ✅ · M7 ⏳（web/file/opencli/ask_user 已落地，shell/browser_use/MCP 未做）。HITL 与编辑器运行聊天化已落地；当日全量代码 review 实证缺口已并入文末「已知缺口」（含误报排除清单，勿再报）。

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

> 实施说明：L1/L2 的 LLM 压缩用独立 compressFn（system prompt「摘要助手」+ maxTokens 1024），失败降级截断；L2 注入限长 1500 字超出按最早条目截断；L3 search 用 LIKE 模糊匹配（向量检索后置）。编排路径暂不注入 L0/L1/L2（仅首页 `ipc/home`）。

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
- [ ] 5.8 i18n 全量（namespace keys 补齐 + **硬编码清零** + Intl.DateTimeFormat）—— 脚手架有；Editor/Agents/Skills/Home 等仍有硬编码中文；`errors.json` 近空
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

---

## 阶段 7：工具与 MCP（持续）

- [ ] 7.1 内置工具 TS 重写（shell / grep / glob / browser_use / desktop_screenshot）—— 已有 `memory_*` / `propose_*` / `ask_user` / `web_search` / `web_read` / `opencli_run` / `file_write` / `file_read` / `file_search`；shell/browser_use 未做
- [x] 7.1c 文件工具（2026-08-01）：`file_write`（原子写/自动建目录/append）+ `file_read` + `file_search`（文件名+内容 OR 匹配）；路径围栏限允许根目录（默认 `~/sh/DailyNotes` Obsidian vault + `userData/exports`，`config/file-roots.json` 或 `ONE_FILE_ROOTS` env 扩展）；4 个 skill 的 agent-reach/search_files 失效引用已全部改指真实工具
- [x] 7.1a 联网工具（2026-08-01）：`web_read`（Jina Reader 免 key）；`web_search`（默认 Bing CN HTML 免 key国内直连，摘要自带相对日期；`JINA_API_KEY` 切 Jina Search；4xx 不重试直接结构化错误）；`opencli_run`（OpenCLI 白名单 spawn，写操作动词拦截，退出码→可行动提示；生产走随包 `vendor/opencli` + `ELECTRON_RUN_AS_NODE` 用户零安装，开发回退系统 PATH）
- [ ] 7.1b `opencli_run` 增强：以 `opencli list -f json` 的 `access: write` 字段做写拦截（自维护，替代静态动词表）；Chrome 扩展未连接的首次运行引导 UI
- [ ] 7.2 MCP 工具协议接入（@modelcontextprotocol/sdk）
- [ ] 7.3 即梦文生图等外部工具
- [x] 7.4 Skill = ContextProvider（`beforeRun`/`afterRun`、discipline 注入、async 脚本 spawn）✅ 2026-08-03
  - `skills/provider.ts`：`SkillContextProvider.beforeRun`（<skill> XML 块 24000 限长 + scripts 清单行 + `【输出纪律】`discipline 段，三处调用点统一收口：编辑器编排 / 首页主 Agent / **首页组队图节点（此前完全没注入 skill，顺带补齐 outputConstraints 注入对齐）**）；`afterRun` 运行结束审计（orchestrate/home 两侧 finally 统一调）
  - `tools/builtin/skillScript.ts`：`skill_run_script` 全局工具——按 id/name 解析技能 → 路径安全（拒绝对路径/`..` 穿越，resolveScriptsDir 向上定位 scripts/ 祖先）→ 解释器路由（.py→python3 / .sh→bash / .js→ELECTRON_RUN_AS_NODE）→ **async spawn**（铁律23：Promise 化 + 60s SIGKILL + AbortSignal 联动 + stdout 256KB 上限 + stderr 尾 4K + 16K 输出截断，纪律复用 opencli_run）；cwd=技能根目录可相对读 resources/
  - 旧 `orchestrator/home.ts buildSkillBlocks` 删除；provider.test.ts 12 例 + skillScript.test.ts 7 例；typecheck + 256 测试全绿

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
| P2 | 崩溃草稿写盘 + UI | 6.4 |
| P2 | 更多 builtin 工具 | 7.1 |
| ~~P3~~ | ~~AbortController 模块级单例~~ ✅ 2026-08-01（入口检测已有运行自动取消旧运行 + finally 只清自己句柄，home/orchestrate 双侧） | ipc/home / orchestrate |
| P3 | win 包 / 编排路径记忆注入 / tasks 落盘 | M6 / M3 尾巴 |

> **2026-08-01 review 误报排除清单（已核实，勿再报）**：① JSON 配置（models/providers/persona）与 vault「读-改-写竞态」——读写全同步（`readFileSync`/`writeFileSync`），事件循环天然原子，加锁为空操作；② `selectSession(result.runId)`——`home:chat` 返回的 runId 按构造即 sessionId；③ `orch_event.done` 与 `message_stop` 间隙——主进程全路径（正常/异常/取消）均配对发送 message_stop（reducer 侧已补 `done` 定格流式态作纵深防御 ✅ 2026-08-01）；④ Magentic 直接 throw——MVP 既定降级设计。

> **2026-08-01 已核实为「设计取舍不改」清单**：① EditorPage 1666 行拆分——重构非缺陷，无 E2E 下回归风险大于收益；② builder.ts `as` 断言类型化——同重构；③ handoff 空 `input_schema` 兼容性——改动可能破坏现有 handoff 链路；④ GroupChat fairness 固定选择顺序——行为变更，源框架同款；⑤ `isTransient` 判定拓宽——误重试风险大于收益；⑥ HomePage 流式数组 / EditorPage onDrop 重建——无实测性能瓶颈的预防性优化，不改。
