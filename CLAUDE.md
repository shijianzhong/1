# One — 项目指南

> 这是 **One**（代号 `one`）：基于 Electron + React + 全 TypeScript 的 AI Agent 可视化编排桌面应用。
> 完整重写设计见 [`docs/REWRITE_PLAN.md`](./docs/REWRITE_PLAN.md)——架构、模块迁移映射、编排引擎自研参考都在那份文档里。本文件只放 AI 协作必需的速查与铁律。
>
> **文档索引**（均在 `docs/`）：
> - [`docs/REWRITE_PLAN.md`](./docs/REWRITE_PLAN.md) — 重写落地文档（架构、模块映射、Agent Framework 自研参考、分阶段计划、**测试策略 §十、错误与崩溃恢复 §十一、i18n §十二**）
> - [`docs/DESIGN.md`](./docs/DESIGN.md) — UI 设计规范（纯白通透玻璃态、色彩/字体/组件、主题系统含背景图）
> - [`docs/UI_BRIEF.md`](./docs/UI_BRIEF.md) — UI 实现简报（各屏幕视觉实现指引，编码 AI 直接读）
>
> **横切约束（见 REWRITE_PLAN 对应章节）**：测试四层（§十）/ IPC 错误统一结构化 + SQLite WAL 恢复 + 草稿恢复（§十一）/ i18n 从一开始做，key 不硬编码中文（§十二）。

## 项目定位

- **目标**：把源项目 Proton（产品名 EClaw 智能助手，代码 `/Users/shijianzhong/enn-workspace/proton`）重写为纯桌面应用。
- **源项目**：FastAPI(Python) + React(Web)，后端约 1.2 万行 Python，前端约 8 千行 TS。
- **Agent Framework 源码**：`/Users/shijianzhong/agent-framework-main`（Python 版，自研编排内核的对照参考）。
- **决策基线**：后端全 TS 重写（不内嵌 Python sidecar）；纯桌面，放弃 Web 部署；前端重写不复用原 UI；**无登录、无鉴权、无用户隔离**（开源个人桌面工具，单用户）；**无地图**（不引入高德）。

## 目录结构（目标态）

```
one/
├── package.json
├── electron-builder.yml
├── electron.vite.config.ts
├── CLAUDE.md / AGENTS.md
├── docs/                      # 设计文档
│   ├── REWRITE_PLAN.md        # 重写落地（架构/迁移/自研参考/阶段）
│   ├── DESIGN.md              # UI 规范（纯白通透玻璃态/主题系统）
│   └── UI_BRIEF.md            # UI 实现简报（编码 AI 直接读）
└── src/
    ├── main/                  # 主进程 = 原 Python 后端的 TS 重写
    │   ├── index.ts           # 窗口/托盘/快捷键/自动更新
    │   ├── ipc/               # ipcMain.handle 注册中心
    │   ├── orchestrator/     # 自研编排内核 @one/orchestrator（逻辑名，非独立 npm 包）
    │   │   ├── models.ts / builder.ts / runner.ts / agent.ts
    │   │   ├── constraints.ts / home.ts   # 输出约束+条件边谓词 / 首页主助手入口
    │   │   └── patterns/      # sequential/concurrent/groupchat/handoff/magentic（builder 配图逻辑，非递归调度器）
    │   ├── llm/               # Anthropic SDK 封装 + 重试
    │   ├── storage/           # SQLite + JSON；含 memory/(L1/L2/L3)，无用户隔离
    │   ├── secrets/          # LLM key 等本地加密存储（crypto）
    │   └── tools/             # 工具注册表
    ├── preload/
    │   └── index.ts           # contextBridge 白名单 → window.one.*
    ├── renderer/              # 重写的 React 前端
    │   └── src/{pages,features,components,api,store,styles}
    └── shared/
        └── types.ts           # 主/渲染共享契约（图模型 + 事件 schema）
```

> 当前阶段：尚未初始化脚手架。目录结构为目标态，落地顺序见 docs/REWRITE_PLAN.md §八。

## 构建与测试命令

> 待脚手架（electron-vite）就绪后填写。预计：
>
> ```bash
> pnpm install
> pnpm dev          # electron-vite 主/preload/渲染一体化热更
> pnpm build        # tsc + vite build（主/preload/渲染）
> pnpm package      # electron-builder 打包
> pnpm typecheck    # tsc --noEmit
> pnpm test         # vitest（编排引擎/记忆/重试单测）
> ```

## 当前阶段

阶段 0（脚手架）之前。详见 docs/REWRITE_PLAN.md §八的分阶段计划（阶段 0~7，其中阶段 7 为持续）。

---

## 代码铁律（必须遵守）

### 安全边界

1. **渲染进程零 Node 特权**：`nodeIntegration: false`，`contextIsolation: true`。所有能力经 preload `contextBridge` 白名单暴露为 `window.one.*`，渲染层绝不直接 `require`/`import` Node 模块。
2. **IPC 收口**：渲染层只调 `window.one.*`，不裸用 `ipcRenderer`。新增能力 = preload 加白名单 + 主进程加 `ipcMain.handle`，二者成对。
3. **密钥不入渲染进程**：LLM key / 中转地址等敏感配置一律只在主进程使用，主进程用 `crypto` 加密存 `userData`；渲染层经 `window.one.secrets.*` 读写，绝不裸持明文 key。
4. **存储路径**：用 `app.getPath('userData')`，不要硬编码 `~/.eclaw/` 或其它路径。
5. **路由用 hashRouter**：`file://` 兼容，不要用 BrowserRouter。

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
- request_info / human-in-the-loop（后置）
- telemetry / OTel 层（空操作或纯日志）
- compaction_strategy / tokenizer（先用简单截断保留最近 N 条）
- MCP 工具（后置，先支持普通 function tool）
- a2a 远程 agent（后置，回退本地）
- 条件边谓词（MVP 只 `contains:` + 恒真）

---

## 协作约定

- 写代码前先读 docs/REWRITE_PLAN.md 对应章节（尤其 §三之三自研参考 + §五核心模块迁移）。
- 编排引擎相关改动，对照源码：框架侧 `/Users/shijianzhong/agent-framework-main`、使用侧 `/Users/shijianzhong/enn-workspace/proton/src/proton/`。
- 每个 PR/提交聚焦一个阶段任务，参考 docs/REWRITE_PLAN.md §八里程碑。
- 不确定的命名/边界，优先遵守上面铁律；铁律没覆盖的，问清楚再写。
