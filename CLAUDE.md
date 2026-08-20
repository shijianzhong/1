# One — 项目指南

> 这是 **One**（代号 `one`）：基于 Electron + React + 全 TypeScript 的 AI Agent 可视化编排桌面应用。
> 完整重写设计见 [`docs/REWRITE_PLAN.md`](./docs/REWRITE_PLAN.md)——架构、模块迁移映射、编排引擎自研参考都在那份文档里。本文件只放 AI 协作必需的速查与铁律。
>
> **文档索引**（均在 `docs/`）：
> - [`docs/REWRITE_PLAN.md`](./docs/REWRITE_PLAN.md) — 重写落地文档（架构、模块映射、Agent Framework 自研参考、分阶段计划、**测试策略 §十、错误与崩溃恢复 §十一、i18n §十二**）
> - [`docs/DESIGN.md`](./docs/DESIGN.md) — UI 设计规范（纯白通透玻璃态、色彩/字体/组件、主题系统含背景图）
> - [`docs/UI_BRIEF.md`](./docs/UI_BRIEF.md) — UI 实现简报（各屏幕视觉实现指引，编码 AI 直接读）
> - [`task.md`](./task.md) — **活的实施清单**（阶段勾选、commit 哈希、已知缺口）；进度以它为准，优于本文件「当前阶段」摘要
>
> **横切约束（见 REWRITE_PLAN 对应章节）**：测试四层（§十）/ IPC 错误统一结构化 + SQLite WAL 恢复 + 草稿恢复（§十一）/ i18n 从一开始做，key 不硬编码中文（§十二）。

## 项目定位

- **目标**：把源项目 Proton（产品名 EClaw 智能助手，代码 `/Users/shijianzhong/enn-workspace/proton`）重写为纯桌面应用。
- **源项目**：FastAPI(Python) + React(Web)，后端约 1.2 万行 Python，前端约 8 千行 TS。
- **Agent Framework 源码**：`/Users/shijianzhong/agent-framework-main`（Python 版，自研编排内核的对照参考）。
- **决策基线**：后端全 TS 重写（不内嵌 Python sidecar）；纯桌面，放弃 Web 部署；前端重写不复用原 UI；**无登录、无鉴权、无用户隔离**（开源个人桌面工具，单用户）；**无地图**（不引入高德）。

## 目录结构（已落地）

```
one/
├── package.json
├── electron-builder.yml
├── electron.vite.config.ts
├── CLAUDE.md / AGENTS.md / task.md
├── docs/                      # 设计文档
│   ├── REWRITE_PLAN.md        # 重写落地（架构/迁移/自研参考/阶段）
│   ├── DESIGN.md              # UI 规范（纯白通透玻璃态/主题系统）
│   ├── UI_BRIEF.md            # UI 实现简报（编码 AI 直接读）
│   └── REVIEW_SUMMARY.md      # 文档 review 汇总（历史结论，进度以 task.md 为准）
├── e2e/                       # Playwright Electron E2E
└── src/
    ├── main/                  # 主进程 = 原 Python 后端的 TS 重写
    │   ├── index.ts           # 窗口/托盘/快捷键/自动更新
    │   ├── ipc/               # ipcMain.handle 注册中心（含 home / orchestrate）
    │   ├── orchestrator/      # 自研编排内核 @one/orchestrator（逻辑名，非独立 npm 包）
    │   │   ├── models.ts / builder.ts / runner.ts / agent.ts
    │   │   ├── home.ts / constraints.ts / userInput.ts  # 首页组队路由 / context_filter / HITL 应答队列
    │   │   └── patterns/      # sequential/concurrent/groupchat/handoff/magentic
    │   ├── llm/               # Anthropic SDK 封装 + 重试 + thinking
    │   ├── storage/           # SQLite + JSON；含 memory/(L0/L1/L2/L3)，无用户隔离
    │   ├── secrets/           # LLM key 本地加密（safeStorage / vault）
    │   ├── skills/            # ZIP 上传解析（ContextProvider 钩子尚未独立模块化）
    │   └── tools/             # 工具注册表（builtin：memory / propose / ask_user / web / file / opencli）
    ├── preload/
    │   └── index.ts           # contextBridge 白名单 → window.one.*（产出 CJS）
    ├── renderer/              # React 前端（pages/components/api/store/styles/i18n）
    └── shared/
        └── types.ts           # 主/渲染共享契约（图模型 + 事件 schema）
```

## 构建与测试命令

```bash
npm install
npm run dev          # electron-vite 主/preload/渲染一体化热更
npm run build        # vite build（主/preload/渲染）
npm run package      # electron-builder 打包（现有 mac dmg）
npm run typecheck    # tsc --noEmit
npm test             # vitest（编排/记忆/重试/颜色等单测）
npm run test:e2e     # 先 build 再 Playwright Electron
npm run rebuild      # better-sqlite3 对应当前 Electron ABI 重编
```

## 当前阶段（2026-08-01 快照）

> **权威勾选见 [`task.md`](./task.md)**；下文是 AI 协作速查摘要。分阶段定义见 [`docs/REWRITE_PLAN.md`](./docs/REWRITE_PLAN.md) §八。

| 阶段 | 状态 | 说明 |
|------|------|------|
| 0 脚手架 | ✅ M0 | electron-vite / IPC / 主题 / i18n 脚手架 / vitest+Playwright |
| 1 存储与配置 | ✅ M1 | SQLite + JSON CRUD、vault、管理页 |
| 2 LLM + 单 Agent | ✅ M2 | `beta.messages.stream`、重试、首页流式聊天 |
| 3 三级记忆 | ✅ M3 | L0–L3 + memory 工具；首页已注入 |
| 4 编排引擎 | ✅ M4 已收口 `4dd76dc` | Pregel runner + 四模式语义保真 + HITL（ask_user）；`context_mode` Sequential 下游接入待联调（M4 尾巴） |
| 5 前端 UI | ✅ M5 | 核心页/画布/主题可用；**i18n 用户可见硬编码已清零**（2026-08-01，交叉校验零缺失）；`errors.*` 主进程 key 未齐 |
| 6 原生与打磨 | ✅ 部分 M6 | 托盘/更新/mac dmg；草稿恢复 UI 未闭环；win 包未验 |
| 7 工具与 MCP | ⏳ 进行中 | memory/propose/ask_user/web/file/opencli 已落地（file_* 已全量异步化）；**Skill ContextProvider + skill_run_script 已落地（7.4 ✅ 2026-08-03）**；**向量知识库 P0-P5 + P3 前置全落地（7.5 ✅ 2026-08-20，`kb:add/pickFile/list/remove/search/reindex/downloadModel/getProviderPreference/setProviderPreference` IPC + pipeline 分块 + v11 content 列 + hybrid 检索 searchKbHybrid[FTS+FlatIndex+RRF] + kb_search 工具 + /kb 前端页 + RemoteEmbeddingProvider 复用 Provider 系统 + reindex 统一循环 + 模型运行时下载/首启 seed + P5 pdf/docx/URL 摄取[unpdf+mammoth+Jina] + P3 前置重调评测[FTS 59.1% > 向量 36.4% → 给 skills 加向量暂缓]）**；shell/browser_use/MCP 未做 |
| 8 Registry | ⏳ 进行中 | Phase 1–5 全落地（仓库+CI/provenance+浏览导入/导出/Token+源管理+自动PR+star+一键更新）；剩余 PR 合并后真实链路验证 |

**当前优先缺口（勿当已完成）：**

1. **崩溃草稿**：哨兵/`listDrafts` 有，编辑器/聊天写盘 + 渲染层恢复 UI 未接。
2. **工具生态**：shell/browser_use/MCP 未做；opencli 写拦截改 `access: write` 自维护（7.1b）。
3. **i18n 尾巴**：`errors.*` 主进程结构化错误 key 未齐（渲染层硬编码已清零）。

> 2026-08-01 review 实证的稳定性项（Error Boundary / fan-in 容错 / WAL checkpoint 备份 / L3 事务 / opencli 限流 / tool_use delta ID / AbortController 加固）已全部修复，见 task.md 缺口表 ✅ 行。

---

## 代码铁律（必须遵守）

### 安全边界

1. **渲染进程零 Node 特权**：`nodeIntegration: false`，`contextIsolation: true`，`sandbox: true`。所有能力经 preload `contextBridge` 白名单暴露为 `window.one.*`，渲染层绝不直接 `require`/`import` Node 模块。
   - **sandbox 与 preload 产出的硬约束**：`sandbox: true` 下 preload 跑在受限环境，**没有 ESM loader，必须产出 CJS**（用 `require`，不能用 `import`）。electron-vite 配 `preload.build.rollupOptions.output = { format: 'cjs', entryFileNames: 'index.cjs' }`，主进程 `webPreferences.preload` 指向 `out/preload/index.cjs`。产出 `.mjs`（ESM）preload 在 sandbox 下会静默不加载 → `window.one` undefined → React 白屏，已踩过。
   - preload 启动时 `existsSync` 校验产物存在，缺失提示先 `npm run build`，避免 preload 静默断导致渲染层裸暴露。
2. **IPC 收口**：渲染层只调 `window.one.*`，不裸用 `ipcRenderer`。新增能力 = preload 加白名单 + 主进程加 `ipcMain.handle`，二者成对。
   - **主进程侧统一经 `withHandler` 包装**（§11.3）：所有 `ipcMain.handle` 用 `main/ipc` 的 `withHandler(channel, fn)` 注册，自动 try/catch 返回判别联合 `IpcResult<T>`（成功 `{ok:true,data}` / 失败 `{ok:false,code,message,retryable}`），不抛未捕获异常。渲染层用 `isIpcFailure()` 解包，`retryable:true` 自动重试一次。`window.one.*` 返回类型一律 `Promise<IpcResult<T>>`，在 `preload/index.ts` 的 `OneApi` 接口里声明。
   - **JSON 配置原子写盘**（§11.4）：`writeJsonAtomic` 临时文件 + rename，防覆盖中途崩溃留半截状态。IPC handler 写 userData JSON 一律走它。
3. **密钥不入渲染进程**：LLM key / 中转地址等敏感配置一律只在主进程使用，主进程用 `crypto` 加密存 `userData`；渲染层经 `window.one.secrets.*` 读写，绝不裸持明文 key。
4. **存储路径**：用 `app.getPath('userData')`，不要硬编码 `~/.eclaw/` 或其它路径。
5. **路由用 hashRouter**：`file://` 兼容，不要用 BrowserRouter。

### 主题与 i18n（横切，从一开始做）

> 详见 docs/DESIGN.md §十二 + docs/REWRITE_PLAN.md §十二。后期 retrofit 贵 10 倍，骨架阶段就立规矩。

T1. **点缀色派生走 OKLCH，不走 RGB 位移**（DESIGN §12.5）：用户给主色 hex（`accent`），前端 `lib/color.ts` 的 `deriveBrandScale()` 用 OKLCH 色空间派生 `brand-300/400/600`（L ±12%/±6%）。RGB 三通道等量位移会让薄荷绿发灰发浊、色相漂移，违背"清透少年感"。新增派生色一律走 `hexToOklch`/`oklchToHex`，单测在 `lib/color.test.ts`。
T2. **i18n key 不硬编码中文**（§十二）：UI 文案一律 `useTranslation()` + key，禁止 JSX 里裸写中文字符串。资源按 namespace 分文件 `public/locales/{zh-CN,en}/{common,home,editor,settings,errors}.json`，经 `i18next-http-backend` 懒加载（`loadPath: './locales/{{lng}}/{{ns}}.json'`，file:// 兼容）。`window.one.*` 返回的错误一律带 i18n key（`errors.*`），渲染层翻译，主进程不硬编码中文报错。
T3. **防首屏闪白**：React 挂载前 `bootstrap-theme.ts` 同步从 localStorage 缓存应用明暗 + 点缀色（theme 存主进程 userData，首屏无法同步 IPC 读，故渲染层 load 后回写缓存）。主题 store load 成功后 `writeThemeCache()` 回写，下次启动 bootstrap 同步应用。

### 编排引擎（自研 @one/orchestrator）

> 详见 docs/REWRITE_PLAN.md §三之三。下面是必须保真的硬约束。

6. **Agent ≠ tool-use 循环**：`Agent` 管 context，tool-use 循环在 LLM client 包装层。不要把循环塞进 Agent。
7. **Pregel superstep 执行模型**：消息 N emit / N+1 deliver；同 superstep 内所有收到消息的 executor 并发（`Promise.all`）。是 wavefront/BFS 层式执行，不是静态拓扑排序。
8. **`max_tokens` 必须从 Agent 配置的默认选项字段读取**（对应原框架 `default_options`），不能放在额外属性里（原框架 `additional_properties` 不会流入请求体）——否则 Anthropic 默认 1024 硬截断。TS 实现里 Agent 构造参数设 `defaultOptions: { maxTokens: 16384 }`，请求体拼装时只从该字段取。
9. **用 Anthropic TS SDK 的 `client.beta.messages.stream()`**（走 beta 端点 + stream 封装）；system message 抽出来作顶层 `system` 参数，不进 messages；`role` 映射 `system`/`tool` → `user`；content 映射 `function_call`↔`tool_use`、`function_result`↔`tool_result`、`text_reasoning`↔`thinking`。
10. **重试包装层必须包裹实际发起 LLM 请求的方法**（对应原框架 `get_response`/`_inner_get_response`），不能只包装顶层调用方法——否则 429/5xx 重试层被绕过。TS 实现里重试装饰器包在 `LLMClient.stream()`（真正调 `beta.messages.stream` 的方法）外层。
11. **工具调用失败返回错误 JSON，不抛异常**——抛异常会让 agent 再次调用形成死循环。
12. **Handoff = synthetic tool + middleware 短路**，不写谓词条件。LLM 调 `handoff_to_X` tool → middleware 注入合成 result → `MiddlewareTermination` 短路循环。
13. **GroupChat 四个 patch 必须保真**：cache_patch（发言请求自带完整历史，治空 cache）、dedup_patch（调 LLM 前 cache 去重）、manager_fairness_patch（有 participant 未发言时强制 terminate=false）、manager_output_patch（剥 markdown 围栏 + 鲁棒 JSON 抽取）。
14. **广播前 `clean_conversation_for_handoff`** 剥 tool 块——防孤儿 tool_use 导致 Anthropic 2013。
15. **`AgentExecutorRequest.should_respond` 双语义**：`true` 触发 run，`false` 仅 extend cache（broadcast 模式）。
16. **`context_mode` 三态**：`full` / `last_agent` / `custom+context_filter`。Sequential 下游无 tool 时必须用 `custom + _strip_tool_blocks_filter` 剥上游 tool 块（治 2013）。
17. **Sequential 下游复述根治**：末条 assistant 且 author≠self 时追加 user 唤醒指令（`wake_on_upstream`）。
18. **孤儿 tool_use 修复**：广播丢"纯 function_result 无 text 的 user 消息"会导致上一 assistant 的 function_call 失配对 → 2013。需 `repair_tool_pairs` 扫 call_id 配对修复。
19. **GroupChat manager 结构化输出**：`AgentOrchestrationOutput{terminate, reason, next_speaker, final_message}`，走 `response_format` 结构化输出。
20. **executor_id == agent name == ReactFlow 节点 id**，1:1 映射，用于前端高亮。

### 三级记忆

21. **三级记忆注入点**：L0 身份块拼进 instructions 开头（单用户下从设置页"个人档案"取，非认证中心）；L1 会话内摘要作首条 system msg + 最近窗口原文（L1 是会话级 LLM 摘要存 SQLite，与 agent 运行时 compaction 不同层级——compaction 是窗口截断防超 token，L1 在前先压缩存档）；L2 跨会话摘要注入 persona（限长 1500 字）；L3 走 `memory_recall`/`memory_search` 工具按需检索，不硬塞 prompt。**不做用户隔离**：存储留 `user_id` 字段默认 `"local"`，仅作未来可选云同步预留位，不实现隔离逻辑。

### Skill

22. **Skill = ContextProvider**：`beforeRun(agent, session, context, state)` 钩子注入——把绑定 SKILL.md inline 成 `<skill>` XML 块（限长 24000 字）+ 输出纪律段拼进 instructions，注入工具到 agent.tools；`afterRun` 读/改状态。Skill 不是普通函数，是 agent 运行前后的上下文注入器。
23. **Skill 脚本执行必须 async**（`child_process.spawn` + Promise 化或 worker_threads）——同步 spawn 会阻塞事件循环，groupchat 多 agent 并发调脚本时会冻死。

### 直答 vs 组队 JSON 判定（首页主助手意图路由）

24. **只有以 `{"role_ids":` 或 `{"capability_ids":` 开头的 `{` 才算组队 JSON 起始**，避免直答正文里的 `body{...}` / `()=>{}` 被误判。维护 24 字符尾部缓冲防跨 chunk 截断。详见 docs/REWRITE_PLAN.md §三之三 M。

---

## 可简化（MVP 不要做）

- Magentic 模式（源项目自己 NotImplementedError，MVP 跳过，用 groupchat+handoff 覆盖）
- checkpoint 持久化（内存态即可）
- telemetry / OTel 层（空操作或纯日志）
- compaction_strategy / tokenizer（先用简单截断保留最近 N 条）
- MCP 工具（后置，先支持普通 function tool）
- a2a 远程 agent（后置，回退本地）
- 条件边谓词（MVP 只 `contains:` + 恒真）

---

## 协作约定

- 写代码前先读 docs/REWRITE_PLAN.md 对应章节（尤其 §三之三自研参考 + §五核心模块迁移）。
- **动手前先看 [`task.md`](./task.md)**：已完成项勿重复；缺口区是优先战场。
- 编排引擎相关改动，对照源码：框架侧 `/Users/shijianzhong/agent-framework-main`、使用侧 `/Users/shijianzhong/enn-workspace/proton/src/proton/`。
- 每个 PR/提交聚焦一个阶段任务，参考 docs/REWRITE_PLAN.md §八里程碑；改完同步勾选 `task.md`。
- 不确定的命名/边界，优先遵守上面铁律；铁律没覆盖的，问清楚再写。
- 本文件「当前阶段」若与 `task.md` 冲突，**以 `task.md` 为准**，并顺手改回本摘要。
