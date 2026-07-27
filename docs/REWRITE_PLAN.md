# One — Electron + React 重写落地文档

> **目标项目**：One（代号 `one`）
> **源项目**：Proton（产品名 EClaw 智能助手），代码位于 `/Users/shijianzhong/enn-workspace/proton`；Agent Framework 源码副本在 `/Users/shijianzhong/agent-framework-main`
> **目标**：将现有 FastAPI(Python) + React(Web) 应用，重写为 Electron + React + 全 TypeScript 后端的纯桌面应用
> **决策基线**：
> - 后端 **全 TS 重写**（不内嵌 Python sidecar）
> - **纯桌面**，放弃 Web 部署能力
> - **前端重写**（不复用原 UI），技术栈仍用 React，但视觉与组件体系全新升级
>
> **关于源项目 Proton/EClaw 的现状概览（§一、§二）**：保留。它是迁移决策与工作量的依据，后续所有迁移映射、风险评估都以此为基础。§一/§二里 "Proton/EClaw" 指源项目，§三之后的目标设计以 "One" 命名。

---

## 一、现状概览（来源：Proton 代码审计）

> 下述 "Proton/EClaw" 均指源项目（待重写的对象）。目标项目命名为 One。

### 1.1 现项目是什么

Proton 是一个 **AI Agent 可视化编排平台**（产品名 EClaw 智能助手），核心能力：

1. **首页主助手**：单 Agent 聊天入口，带三级记忆
2. **能力编排画布**：基于 ReactFlow 的可视化 agent 编排器，支持 6 种节点类型
3. **多角色协作**：Sequential / Concurrent / GroupChat / Handoff / Magentic 五种编排模式
4. **管理后台**：角色、技能、模型、人设管理
5. **工具调用**：Shell / 文件读写 / 浏览器自动化 / 桌面截图 / 知识库 / 文生图 等

### 1.2 现技术栈

| 层 | 技术 | 规模 |
|---|---|---|
| 后端 | Python 3.11 + FastAPI + Microsoft Agent Framework + Anthropic SDK | 35 文件 / ~11,781 行 |
| 前端 | React 19 + Vite + Ant Design v6 + @xyflow/react v12 + react-router v7 | ~30 文件 / ~7,914 行 |
| 存储 | `~/.eclaw/` 全量 JSON 文件（无数据库） | `storage.py` 2065 行 |
| 部署 | Docker（Linux） | — |

> **重写说明**：本项目定位为开源个人桌面工具，用户自行下载安装、自配 LLM key、数据存本地。**登录、第三方鉴权、用户隔离全部不迁移**；高德地图亦不迁移。详见 §5.4。

### 1.3 最复杂的三块（重写风险点）

| 模块 | 文件 | 复杂度 | 说明 |
|---|---|---|---|
| 持久化 + 三级记忆 | `storage.py` (2065 行) | ★★★★★ | L1 滚动压缩 / L2 跨会话精炼 / L3 长期沉淀 + 会话/任务历史（重写时去掉源项目的用户隔离维度，单用户） |
| 编排引擎 | `orchestrator/builder.py` + `runner.py` + `models.py` | ★★★★ | JSON 图 → Agent Framework Workflow，含条件边、6 种节点类型、SSE 流式 |
| LLM 客户端 | `llm.py` | ★★★ | Anthropic 中转 + 指数退避重试包装（429/5xx/网络错误） |

> ⚠️ Microsoft Agent Framework 是 .NET/Python 实现，**TypeScript 无对应包**，编排引擎必须自研。

---

## 二、目标架构

### 2.1 总体架构图

```
┌─────────────────────────────────────────────────────────┐
│                   Electron 主进程 (Node.js)              │
│                                                          │
│  ┌────────────┐  ┌────────────┐  ┌───────────────────┐  │
│  │ 窗口/托盘   │  │ 全局快捷键  │  │ 自动更新(electron-│  │
│  │ BrowserWindow│ │ globalShortcut│ │ updater)        │  │
│  └────────────┘  └────────────┘  └───────────────────┘  │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │              IPC 网关 (ipcMain.handle)             │   │
│  └──────────────────────────────────────────────────┘   │
│                          ▲                              │
│  ┌───────────────────────┼───────────────────────────┐ │
│  │           本地后端服务 (全 TS 重写)                  │ │
│  │                                                      │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │ │
│  │  │ 编排引擎  │ │ 记忆引擎  │ │  LLM 客户端+重试  │   │ │
│  │  │(自研,TS) │ │(L1/L2/L3)│ │ (Anthropic SDK)  │   │ │
│  │  └──────────┘ └──────────┘ └──────────────────┘   │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │ │
│  │  │ 工具注册表 │ │ （无鉴权） │ │ （无地图代理）   │   │ │
│  │  └──────────┘ └──────────┘ └──────────────────┘   │ │
│  │  ┌────────────────────────────────────────────┐    │ │
│  │  │    存储层 (本地 SQLite + JSON 文件)         │    │ │
│  │  └────────────────────────────────────────────┘    │ │
│  └────────────────────────────────────────────────────┘ │
│                          │                              │
│  ┌───────────────────────▼───────────────────────────┐ │
│  │     preload.ts (contextBridge 暴露安全 API)        │ │
│  └───────────────────────────────────────────────────┘ │
└─────────────────────────┼───────────────────────────────┘
                          │ contextBridge / ipcRenderer.invoke
┌─────────────────────────▼───────────────────────────────┐
│              渲染进程 (React 19 + Vite)                  │
│                                                          │
│  ShadCN UI + Radix + Tailwind v4 + @xyflow/react v12 + react-router v7 │
│  画布编辑器 / 聊天 / 管理后台                            │
└──────────────────────────────────────────────────────────┘
```

### 2.2 进程职责划分

| 进程 | 职责 | 技术 |
|---|---|---|
| **主进程** | 窗口/托盘/菜单/快捷键/自动更新；承载全 TS 后端业务；管理持久化；网络代理 | Node.js + Electron |
| **preload** | 通过 `contextBridge` 暴露白名单 IPC API 给渲染层 | Electron preload |
| **渲染进程** | 纯 UI，零 Node 能力，所有数据/能力走 `window.one.*` 调用 | React + Vite |

### 2.3 关键设计原则

1. **渲染进程零特权**：`nodeIntegration: false`，`contextIsolation: true`，所有能力经 preload 白名单。
2. **IPC 即 API**：原前端 `api.ts` 的 `fetch('/api/...')` 全部替换为 `window.one.xxx()` → `ipcRenderer.invoke` → 主进程 handler。
3. **流式走事件**：原 SSE（`text/event-stream`）改为 `webContents.send` 主进程→渲染进程单向事件流。
4. **存储下沉本地**：JSON 文件存储升级为 SQLite（记忆/会话/任务历史）+ JSON（配置/角色/能力图）。源项目 `~/.eclaw/` 迁到 `app.getPath('userData')`。
5. **AI 编排自研**：用 TypeScript 重新实现 Agent + 5 种编排模式，直接调 Anthropic SDK（或中转）。

---

## 三、技术栈选型

### 3.1 桌面框架与构建

| 用途 | 选型 | 理由 |
|---|---|---|
| 桌面框架 | **Electron 34+** | 生态成熟，与 React 同 JS 栈，便于复用前端 |
| 打包分发 | **electron-builder** | 支持 mac（dmg）/ win（nsis）/ linux（AppImage），支持自动更新 channel |
| 自动更新 | **electron-updater**（基于 electron-builder） | 文档完善，支持私有/公共 update server |
| 主进程语言 | **TypeScript 5.8** | 与前端同语言，类型贯穿 |
| 进程管理 | electron 内置 + `concurrently`（dev） | — |

### 3.2 前端（重写，全新视觉与组件体系）

原前端 UI 丑、组件组织散乱，**不复用任何 UI 代码**，仅复用业务领域知识（画布节点契约、API 调用语义、聊天流式渲染逻辑）。技术栈仍用 React，但视觉与组件体系全新设计。

| 用途 | 选型 | 说明 |
|---|---|---|
| UI 框架 | **React 19** | — |
| 构建工具 | **electron-vite** | 主/preload/渲染一体化热更 |
| 组件库 | **ShadCN UI + Radix Primitives + Tailwind v4** | 弃用 Ant Design。ShadCN/Radix 可控、可深度定制、视觉现代，避免 AntD "千篇一律的后台味"；Tailwind v4 主题化方便做深色模式与品牌色 |
| 图标 | **Lucide React** | 现代线性图标，与 ShadCN 配套 |
| 画布 | **@xyflow/react v12** | 画布是核心资产，节点组件全部重写（视觉与交互），但图模型契约（节点类型/边/坐标）沿用 |
| 路由 | **react-router-dom v7（hashRouter）** | file:// 兼容 |
| 状态管理 | **Zustand + immer** | 集中管理会话/任务流/编排运行态，替代原分散的 useState/localStorage |
| 数据请求 | **TanStack Query** | 管理服务端态（能力/角色/技能列表），缓存与失效，替代原裸 fetch |
| Markdown | **react-markdown + rehype-highlight / rehype-katex / remark-gfm / remark-math** | 重写渲染样式（代码块/公式/引用块/表格全部重做视觉） |
| 数学公式 | **KaTeX** | — |
| 动效 | **Framer Motion** | 列表/抽屉/消息流微动效，提升质感 |
| 表单 | **React Hook Form + Zod** | 与主进程共享 Zod schema |
| 字体 | Inter（西文） + 思源黑体（中文） | 现代无衬线，避免默认系统字体感 |

### 3.3 后端（全 TS 重写）

| 用途 | 选型 | 替代原 |
|---|---|---|
| AI/LLM | **@anthropic-ai/sdk**（或 Anthropic 兼容中转）+ 自研编排 | agent-framework-* + anthropic |
| 编排引擎 | **自研 `@one/orchestrator`**（TS） | agent-framework-orchestrations |
| 持久化 | **better-sqlite3**（同步、快）+ JSON 文件 | storage.py JSON 文件 |
| 配置 | **Zod** + dotenv | pydantic-settings |
| 加密 | Node `crypto`（key 等敏感配置本地加密存储） | cryptography |
| HTTP 客户端 | Node 18+ 内置 `fetch` / `undici` | httpx |
| 日志 | **electron-log** | Python logging |
| 流式 | Electron `webContents.send` | FastAPI SSE |
| 工具协议（MCP） | **@modelcontextprotocol/sdk** | mcp (Python) |

---

## 三之二、Agent Framework 怎么办？

> 这是全 TS 重写路线**最需要拍板的技术点**。结论：**自研一个等价编排内核**（`@one/orchestrator`），不依赖任何现成多 Agent 框架，但**借力 Anthropic TS SDK 做底层 LLM 调用与 tool-use 循环**。
>
> 依据：已深读 `/Users/shijianzhong/agent-framework-main` 框架源码 + proton 的 `orchestrator/`、`llm.py`、`tools/registry.py`、`.venv` 里三个框架包，详见 §三之三（自研参考）。两路梳理结论一致，作为 TS 实现的二次校验。

### A. 为什么不能直接搬

经核验（Context7 官方库数据），Microsoft Agent Framework **官方仅支持 .NET 与 Python 两语言**，没有任何 JS/TS SDK：

- 库 `/microsoft/agent-framework`：573 段代码，官方描述明确写 "supporting both .NET and Python"
- 官方文档库 `/websites/learn_microsoft_en-us_agent-framework` 同样只覆盖 .NET/Python
- 社区无第三方 TS 移植版

所以"用 npm 装一个 agent-framework 的 TS 版"这条路不存在，必须自研或借力。

### B. 三条候选路径

| 路径 | 做法 | 评价 |
|---|---|---|
| **① 全自研编排** | 自己实现 Agent + 5 种编排模式 + 条件边，直连 Anthropic TS SDK | ✅ **推荐**。等价于把 `builder.py`/`runner.py` 翻译成 TS，逻辑可控、行为可对照原项目、无外部黑盒。Agent 底层（消息循环、tool-use、流式）由 Anthropic SDK 承担，不用从零写。 |
| ② 借力成熟多 Agent 库 | 用 TS 生态现成框架（如 `LangGraph.js`、`Mastra`、`Vercel AI SDK` 的 agent 能力）承担编排 | ⚠️ 可选但需改造。这些库有 Sequential/Parallel/条件路由概念，但与原项目 6 种节点（尤其 GroupChat/Magentic/Handoff）语义不完全对齐，强行套会变形且引入重依赖。 |
| ③ 直调 Anthropic SDK + 最小封装 | 不抽编排框架，每种编排模式直接在 runner 里手写执行流 | ⚠️ 起步快，但画布编辑器/条件边/可复用执行计划需要抽象，后期会重构。 |

### C. 推荐方案：自研内核 + Anthropic SDK 打底

**分工**：把原 Agent Framework 的职责拆成两层，TS 重写上层、借力下层。

```
┌──────────────────────────────────────────────┐
│  @one/orchestrator  （自研上层，TS）            │
│   - models.ts        图模型（6 节点类型 + 边）    │
│   - builder.ts       JSON 图 → RuntimeWorkflow  │
│   - runner.ts        DAG 执行 + 事件流            │
│   - agent.ts         单 Agent 执行单元            │
│   - patterns/        sequential/concurrent/        │
│                      groupchat/handoff/magentic  │
└──────────────────────────────────────────────┘
                    │ 调用
┌──────────────────────────────────────────────┐
│  @anthropic-ai/sdk   （借力下层，现成）          │
│   - beta.messages.stream()  流式 + tool_use 循环 │
│   - tool_use/tool_result 协议                     │
│   - token 计数 / 多模态 / 重试（底层）            │
└──────────────────────────────────────────────┘
```

**关键点：Anthropic TS SDK 已经自带 tool-use 循环**（`beta.messages.stream` + `tool_use`/`tool_result`，TS 实现统一用此 API，见铁律 9），这正是原 Agent Framework 里单 Agent 的底层能力。自研部分只负责**多 Agent 怎么编排**（谁先跑、谁并发、群聊怎么轮转、何时转交），这是 `builder.py`/`runner.py` 翻译成 TS，工作量可控且可对照。

### D. 自研编排内核的最小骨架（5 种模式）

> ⚠️ 执行模型必须是 **Pregel superstep**（铁律 7 + §三之三 E），不是递归调度器。下面的 pattern 函数是 **builder 逻辑**（产出 Workflow 图 + 节点的消息处理 handler），运行时由 runner 的 superstep 循环统一调度，不要写成递归 `runNode(child)` 调用——那样无法表达 GroupChat 的 `should_respond=false` 广播（仅 extend cache 不触发 run）和 wavefront 并发。

**两层抽象**：

```ts
// —— 第一层：Executor（workflow 节点）——
// 每个 Executor 有 @handler 方法接收消息（should_respond 决定是否 run）
interface Executor {
  id: string;
  cache: Message[];              // 本节点消息缓存
  handle(req: ExecutorRequest, ctx: WorkflowContext): AsyncIterable<StreamEvent>;
}
interface ExecutorRequest { messages: Message[]; should_respond: boolean; }  // false=仅 extend cache

// —— 第二层：WorkflowContext（Pregel 运行时）——
interface WorkflowContext {
  send_message(data: unknown, target_id?: string): Promise<void>;  // 发下游（无 target=fan-out）
  yield_output(data: unknown): Promise<void>;                       // 产出 terminal 输出
  add_event(e: StreamEvent): Promise<void>;                         // 自定义事件（handoff_sent 等）
  get_source_executor_id(): string;
}

// —— 五种 Pattern = 五种 Executor 子类 + builder 配图 ——
// builder 把 ReactFlow JSON 转成 Workflow 图（节点=Executor，边=消息通路）。
// 每种 pattern 的差异体现在 Executor.handle 的消息处理逻辑 + builder 配的边结构：

// Sequential：线性边 A→B→C，上游 full_conversation extend 到下游 cache；
//   下游无 tool 时挂 strip_tool_history 中间件剥 tool 块（治 2013），
//   末条 assistant 非自己时追加 user 唤醒指令（wake_on_upstream 治复述）。
// Concurrent：dispatcher fan-out 给所有 participant（同 superstep 并发），
//   fan-in 等 all 到齐再调 aggregator 取每个最后 assistant msg 拼合。
// GroupChat：每轮 broadcast 给所有 participant（should_respond=false 仅 extend cache）
//   → 定向请求 next_speaker（should_respond=true 触发 run）→ 收响应 → broadcast(excl 发言者)
//   → 下一轮。manager 模式用结构化输出 AgentOrchestrationOutput 决策；round_robin 用 selection_func。
// Handoff：每个 agent clone + 注入 handoff_to_<target> synthetic tool + _AutoHandoffMiddleware，
//   LLM 调 handoff tool → middleware 短路 → 扫 function_result 解析 target → ctx.send_message(target)。
//   无谓词条件，"条件"就是 LLM 选择调哪个 handoff tool。
// Magentic：MVP 跳过（见 §三之三 K#1），用 groupchat+handoff 覆盖。
```

**runner 的 superstep 主循环**（不是递归）：

```ts
// main/orchestrator/runner.ts —— Pregel 模型，等价 §三之三 E
async function runWorkflow(wf, input, sessionId, onEvent) {
  const ctx = createWorkflowContext(wf, onEvent);
  ctx.deliver(input, wf.startExecutor);          // 初始消息投递
  while (!ctx.converged()) {                      // 收敛 = 无 pending 消息
    onEvent({ type: 'superstep_started' });        // 可选，不透前端
    const pending = ctx.drainPending();            // 取本 superstep 待投递消息
    const bySource = groupBy(pending, m => m.source);
    await Promise.all(                             // 同 superstep 内所有 source 并发
      bySource.map(([src, msgs]) => ctx.deliverGroup(src, msgs))
    );
    ctx.commit();
    onEvent({ type: 'superstep_completed' });
  }
  onEvent({ type: 'done' });
}
```

> **为什么不能递归**：GroupChat 的 `should_respond=false` 广播只 extend cache 不触发 run，下一轮发言者的 `should_respond=true` 才 run——这依赖 superstep 的"消息在 N emit、N+1 deliver"语义，递归调用无法表达。Sequential/Concurrent 虽然可以递归模拟，但为统一执行模型，全部走 Pregel。

### E. 迁移纪律（保真三条）

1. **冻结原行为作黄金用例**：先把原 `builder.py`/`runner.py` 6 种节点 + 条件边的执行行为，用若干组（输入图, 输入文本, 期望事件序列）固化成测试用例，重写后逐条断言通过。
2. **顺序**：先 Sequential/Agent 叶子（最简）→ Concurrent → Handoff → GroupChat（最难）。Magentic MVP 跳过。GroupChat 的发言者选择是难点，留到编排引擎阶段最后做。
3. **不贪大**：自研内核只实现原项目用到的 5 种模式 + 条件边，不做通用框架，不做插件化，够用即停。

### F. 备选：若中途发现 GroupChat/Magentic 自研代价过高

- 可在**这两种模式**上局部引入 `LangGraph.js` 的状态图能力，其余仍自研——混合方案，不传染全局。但默认走全自研，除非验证阶段证明自研成本失控。

---

## 三之三、自研参考（深读源码梳理）

> 深读框架源码 + proton 使用代码后的结论性梳理，直接作为 TS 自研内核的设计依据。代码片段精简，关键细节齐全。

### A. 框架整体架构与类层级

```
Agent = AgentMiddlewareLayer + AgentTelemetryLayer + RawAgent + BaseAgent
       (run 包装)           (telemetry)        (核心)
       ↓
AgentExecutor(Executor)   ← 把 agent 包成 workflow 节点
       ↓
WorkflowBuilder → Workflow                  ← 图引擎
       ↓
SequentialBuilder / ConcurrentBuilder / GroupChatBuilder / HandoffBuilder / MagenticBuilder
       (都最终产 Workflow，内部用 WorkflowBuilder 组装)

AnthropicClient = FunctionInvocationLayer + ChatMiddlewareLayer + ChatTelemetryLayer + RawAnthropicClient
       (tool-use 循环)      (chat 中间件)      (遥测)        (SDK 调用)
```

**核心事实**：`Agent` 自身**不含 tool-use 循环**，只是 options/session/middleware 管理器；循环在 `AnthropicClient` 的 `FunctionInvocationLayer` 里。TS 自研应照此分层：`Agent` 管 context，`AnthropicClient` 等价物管循环。

### B. 6 种节点类型精确定义（对应 models.py）

`OrchestrationKind` 枚举 6 值，`GraphNode` 统一容器按 kind 携带不同子配置。

| Kind | 数据结构字段 | 语义 |
|---|---|---|
| **agent** | `name(=节点id=executor_id)`, `description`, `instructions`, `tools: list[ToolDef]`, `mcp_tools`, `model_id`, `source(builtin/a2a/custom)`, `role_id`, `a2a_url`, `temperature`, `max_tokens`, `skill_source_ids`, `skill_bindings`, `output_constraints` | 单 LLM 执行单元。name 三合一：ReactFlow 节点 id / agent name / 流式事件 executor_id，前端高亮用 |
| **sequential** | `participants: list[str]`（顺序敏感）, `output_from: "all"/"last"`, `intermediate_output_from?: "none"/"all_other"`（默认 none，仅末位 emit output） | 链式串行容器，按 list 顺序接力 |
| **concurrent** | `participants: list[str]` | fan-out/fan-in 并行容器 |
| **groupchat** | `participants`, `selector_mode: "round_robin"/"manager"`, `max_rounds=6` | 多轮群聊；manager 用 LLM 主持人决策 |
| **handoff** | `participants`, `handoffs: list[HandoffEdge{source, targets}]`, `start_agent` | 条件转交容器；agent 调 `handoff_to_X` 工具触发 |
| **magentic** | `manager: str`, `workers: list[str]` | Leader-Worker（**proton 未启用，raise NotImplementedError**） |

`GraphEdge{source, target, condition: str|None}` —— condition 非 None 即分支边（MVP 仅支持 `contains:<sub>` 谓词）。

### C. builder 转换逻辑（对应 builder.py 1313 行）

**顶层 `build_workflow(graph)`**：
1. 单节点（无边或单节点）→ 直接 `_build_entity` 返回。
2. 多节点 → `WorkflowBuilder` 组装：容器节点产出 Workflow 后 `.as_agent(name=n.id)` 包成 agent 才能作图中节点；普通边 `add_edge`；条件边按 source 聚合 → `add_switch_case_edge_group(src, [Case(predicate, target)..., Default(target)])`。
3. **无显式拓扑排序**：拓扑由 Pregel superstep 模型隐式保证（§E）。

**`_build_entity` 分支**：

| kind | builder 调用 | 关键细节 |
|---|---|---|
| agent | `_build_agent(...)` | 见 §D |
| sequential | `SequentialBuilder(participants, output_from).build()` | 从第二位起挂 `wake_on_upstream` 中间件（根治复述）；下游用 `context_mode="custom" + context_filter=_strip_tool_blocks_filter` 剥上游 tool 块（治 2013） |
| concurrent | `ConcurrentBuilder(participants).build()` | 无额外处理 |
| groupchat | manager：`GroupChatBuilder(participants=rest, orchestrator_agent=first, max_rounds).build()`；round_robin：传 `selection_func` | 所有 participant 挂 `repair_tool_pairs` 修复孤儿 tool_use |
| handoff | `HandoffBuilder(participants).add_handoff(s,t).with_start_agent(start).build()` | `for_handoff=True` 开 `require_per_service_call_history_persistence` |
| magentic | `raise NotImplementedError` | 降级提示改用 groupchat/handoff |

**`_build_agent` 关键 kwargs**：

```ts
new Agent({
  client: getClient(model_id),     // RetryingClient
  name, instructions,               // 拼装见 §D
  tools: all_tools || undefined,
  default_options: {                // ⚠️ 必须走 default_options，框架只从这里读
    max_tokens: max_tokens ?? 16384,  // ⚠️ 缺省默认 1024 会被硬截断
    ...(temperature != null && { temperature }),
  },
  middleware: [...],               // strip_tool_history / repair_tool_pairs / wake_on_upstream
  context_providers: skillProviders, // SkillsProvider
  ...(for_handoff && { require_per_service_call_history_persistence: true }),
});
```

**⚠️ 巨坑**：`max_tokens` 必须走 `default_options`，不能走 `additional_properties`——框架只从前读，否则所有 agent 走默认 1024 被硬截断。TS 自研要保留这个读取口。

### D. 单 Agent 执行 + 三级记忆注入

**instructions 拼装顺序**（system prompt 注入点）：
1. `_compose_role_prompt(role_id)`：`build_user_identity_block()`（当前用户身份段，不挂 token）+ PROFILE.md + 角色卡片（scenes/summary/judgments）
2. `cfg.instructions`（节点自带）
3. `_compose_bound_skill_prompt(...)`：绑定 SKILL.md inline 成 `<skill>` XML 块（限长 24000 字）+ "输出纪律铁律"段
4. `cfg.output_constraints`（"≤N字/一句话"约束）
5. 末段"禁止自报家门/禁止过程描述"铁律

**三级记忆注入**（home.py）：
- **L0 实时上下文**：`build_user_identity_block()` 拼进 instructions 开头（源项目从认证中心拿用户身份）。**单用户桌面版无鉴权**：L0 身份块改为从本地用户档案（设置页里填的"我的称呼/角色"）取，无则留空。
- **L1 会话内滚动摘要**：`session.memory.summary` 做成首条 system msg（`【早期对话摘要】\n{summary}`）+ 最近窗口原文 `messages[summarized_up_to:]`
- **L2 跨会话摘要**：`_build_l2_injection(username)` 读 `list_l2_index` 拼成 `【该用户历史对话摘要】` 段注入 persona（限长 1500 字）
- **L3 长期记忆**：通过 `memory_recall`/`memory_search` 工具按需检索（不硬塞 prompt）

**tool-use 循环**（在 `FunctionInvocationLayer`，TS 等价物在 AnthropicClient 包装层）：
```
for attempt in range(max_iterations):
  approval = await process_function_requests(response, messages)
  if approval.action == "stop": break
  if 超过 max_function_calls: options.tool_choice = "none"
  response = await super.get_response(messages, options)
  result = await process_function_requests(response, messages)
  if result.action == "return": return response
  // 否则把 response.messages 并入 messages，继续下一轮
// loop exhausted: 最后一次 tool_choice="none" 调用收尾
```
**终止条件**：无 `function_call` 在 response / `max_iterations` / `max_function_calls` 总预算 / `max_consecutive_errors` → 设 `tool_choice="none"` 收尾 / `MiddlewareTermination` 异常（handoff 用）。

### E. Pregel superstep 执行模型（框架内核，TS 必须等价）

`Runner.run_until_convergence`：
```
while iteration < max_iterations:
  yield superstep_started
  iteration_task = create_task(run_iteration())
  while not iteration_task.done():
    event = await ctx.next_event(timeout=0.05)
    yield event              // 实时流式事件
  await iteration_task
  ctx.state.commit()
  yield superstep_completed
  if not await ctx.has_messages(): break   // 收敛
```

`run_iteration`：drain 所有 pending messages，按 source executor 分组，每组通过 `EdgeRunner` 并发 deliver（`asyncio.gather` over edge runners，TS 用 `Promise.all`）。**同一 superstep 内所有收到消息的 executor 并发执行**；本 superstep emit 的消息下个 superstep 才 deliver。这是 wavefront/BFS 层式执行，不是静态拓扑排序。

### F. runner 事件流与 SSE 映射（对应 runner.py）

过滤内部 adapter executor（`_INTERNAL_EXECUTOR_HINTS = ("input-conversation","to-conversation:","complete","dispatcher","aggregator","group_chat_orchestrator")`）。

| WorkflowEvent.type | TS 事件 (替代 SSE) | 说明 |
|---|---|---|
| `executor_invoked` | `{type:"node_started",node_id}` | executor 开始 |
| `executor_completed` | `{type:"node_done",node_id}` | executor 完成 |
| `executor_failed` | `{type:"node_error",node_id,error}` | 异常 |
| `intermediate` | `{type:"output",node_id,speaker,text}` | 群聊逐 token 流式 |
| `output` | `{type:"output",node_id,speaker,text}` | 最终输出（过滤 "maximum rounds"/"terminated" 默认文案） |
| `handoff_sent` | `{type:"handoff",from,to}` | handoff 转交 |
| `failed` | `{type:"failed",error}` | 编排失败 |
| (流结束) | `{type:"done"}` | 正常结束 |

**TS 替代 SSE**：主进程 `mainWindow.webContents.send('orchestrate:stream', event)`，渲染层 `ipcRenderer.on` 订阅。

**中断/取消**：原项目无显式 cancel，靠前端断开触发 GeneratorExit。TS 应增加显式 `AbortController` + cancel token 透传（改进点）。

### G. 5 种编排模式实现细节

**Sequential**：默认 `context_mode="full"`，上游 `full_conversation` extend 到下游 cache，下游拿到完整历史。proton 改造：从第二位起挂 `wake_on_upstream`（末条 assistant 且 author≠self 时追加 user 唤醒指令，根治复述）；下游 `context_mode="custom" + _strip_tool_blocks_filter` 剥上游 tool 块（治 2013）。

**Concurrent**：`ConcurrentBuilder` 接 `_DispatchToAllParticipants → fan-out → participants → fan-in → _AggregateAgentConversations`。`add_fan_out_edges` 创建 `FanOutEdgeGroup`；单 superstep 内所有 participant 并发（`Promise.all` 等价）。aggregator 从每个 participant 取最后一条 assistant 消息按顺序拼。

**GroupChat**：
- round_robin：`selection_func = state => names[state.current_round % len(names)]`
- manager：传 `orchestrator_agent`，用 LLM 主持人输出 `AgentOrchestrationOutput{terminate, reason, next_speaker, final_message}`（结构化输出，走 `response_format`）
- 广播：`_broadcast_messages_to_participants` 用 `Promise.all` over `[_send_messages(p) for p in participants]`，每个收 `AgentExecutorRequest(messages, should_respond=False)`（仅 extend cache 不触发 run）
- 终止：`max_rounds` 命中 / manager `terminate=true` / `termination_condition`
- proton 的 4 个 patch（TS 必须保真）：
  1. **cache_patch**：发言请求自带完整对话历史（治偶发空 cache → 2013）+ `_speaker_output_constraint_text` 作为最后 user 指令
  2. **dedup_patch**：调 LLM 前对 cache 去重（按 message_id 或 role+author+text）
  3. **manager_fairness_patch**：manager 判 terminate=true 时若仍有 participant 未发言 → 强制 `terminate=false + next_speaker=unspoken[0]`
  4. **manager_output_patch**：剥 markdown 围栏 + 鲁棒 JSON 抽取 + 正则兜底（治 Anthropic 偶发包 ```json``` 围栏）

**Handoff**：**无谓词条件**——"条件"就是 LLM 调 `handoff_to_X` 工具。`HandoffAgentExecutor` 给 agent clone 一份，每个 target 加 synthetic `FunctionTool(name=handoff_to_{target})` + `_AutoHandoffMiddleware`。LLM 调 handoff tool → middleware 拦截 → 注入 `{"handoff_to": target}` result → `raise MiddlewareTermination` **短路 tool 循环** → `_is_handoff_requested` 扫描最后 response 的 function_result → 路由到 target。必须开 `require_per_service_call_history_persistence=True`（middleware 短路导致 service 看不到 handoff tool result）。

**Magentic**：proton 未启用（`NotImplementedError`）。框架层：`MagenticManager` 四能力（`plan`/`replan`/`create_progress_ledger`/`prepare_final_answer`），调度循环：`progress_ledger → 判 is_request_satisfied / is_in_loop / stall → 选 next_speaker + instruction → send_request → handle_response`。**TS MVP 可跳过**，用 groupchat(manager)+handoff 覆盖。

### H. 重试策略（对应 llm.py）

`RetryingAnthropicClient` 包装 `AnthropicClient`，`__getattr__` 拦截 5 个方法名（`chat`/`messages`/`__call__`/`get_response`/`_inner_get_response`）——**必须包含后两个**，框架实际走前两者，否则 429/5xx 重试层被绕过。

- `max_retries = 3`
- 退避：`min(10.0, 1.0 * 2^attempt)` —— 1s/2s/4s
- Jitter：`delay * 0.2 * (random()*2-1)` —— ±20% 防惊群
- 重试条件：httpx 网络异常 / HTTP 429/500/502/503/504 / 异常类型名或消息含 `rate_limit`/`overloaded`/`timeout`/`connection`/`429`/`backend returned`（中转网关报错兜底）
- **不重试**：401/400/ValidationError
- `@lru_cache(maxsize=16)` 缓存 client（按 model_id）
- 中转代理用 `Authorization: Bearer`（`auth_token`），非官方 `x-api-key`

### I. Anthropic SDK 调用关键细节

- 用 `beta.messages.create`（非 `messages.create`），betas 默认 `["mcp-client-2025-04-04","code-execution-2025-08-25"]`，结构化输出加 `"structured-outputs-2025-11-13"`。**TS 实现对应 `client.beta.messages.stream()`**（见铁律 9），统一用此 API；betas 实现前用 `claude-api` 技能查当前 GA 状态，已转稳定的改用稳定 API（见 §九风险）。
- **system message 抽出来作 `system` 顶层参数**，不进 messages
- `max_tokens` 必传（Anthropic 强制，缺省默认 1024，proton 改 16384）
- `role` 映射：`system`/`tool` → `user`
- content 映射：`function_call`↔`tool_use`、`function_result`↔`tool_result`、`text_reasoning`↔`thinking`
- 流式：`async for chunk in beta.messages.create(stream=True)` → `_process_stream_event` 按 type 转换（`message_start`/`message_delta`/`content_block_start`/`content_block_delta` 有输出，`message_stop`/`content_block_stop` 无）

### J. 工具注册表（对应 tools/registry.py）

- `register_tool(name, description, params, approval_mode)` 装饰器把普通函数包成 `FunctionTool`
- **必须显式构造 JSON Schema 传给 `af_tool(schema=...)`**——因为 wrapper 用 `*args/**kwargs` 签名，否则 LLM 看到无参数工具
- **工具调用失败重试 3 次（0.5/1/1.5s 退避），耗尽后返回错误 JSON 不抛异常**——抛异常会让框架再次调用形成死循环
- 内置工具：`http_call`（stream 读完整 body，截断 20000 字）、`memory_recall`/`memory_search`/`memory_retain`、`read_file`

### K. 自研要点清单

**必须保真的行为点**：
1. Agent ≠ tool-use loop；Agent 管 context，循环在 client 包装层
2. Pregel superstep 执行模型（N emit / N+1 deliver，同 superstep 并发）
3. WorkflowEvent 类型全集 + 过滤内部 adapter executor
4. `AgentExecutorRequest.should_respond` 双语义（true 触发 run，false 仅 extend cache）
5. `context_mode` 三态（full / last_agent / custom+filter）
6. `output_from`/`intermediate_output_from` 决定 output/intermediate 事件
7. Handoff = synthetic tool + middleware short-circuit（不写谓词）
8. GroupChat manager 结构化输出 `AgentOrchestrationOutput{terminate,reason,next_speaker,final_message}`
9. `clean_conversation_for_handoff` 广播前剥 tool 块防孤儿
10. `max_tokens` 走 `default_options`；用 `beta.messages.create`；system 抽出作顶层参数；role 映射；content 映射
11. 重试必须包 `get_response`/`_inner_get_response`，不能只包 `chat`/`messages`
12. Skill = ContextProvider（`beforeRun` 注入 instructions/tools）
13. 工具失败返回 JSON 不抛异常

**容易踩坑（必须实现等价中间件/补丁）**：
1. **孤儿 tool_use → Anthropic 2013**：广播丢"纯 function_result 无 text 的 user 消息" → 上一 assistant 的 function_call 失配对。需 `repair_tool_pairs` 扫 call_id 配对修复
2. **Sequential 下游复述上游**：末条 assistant 是上游产出无后续 user → LLM 续写上游。需 `wake_on_upstream` 追加 user 唤醒指令
3. **Sequential 下游 tool 块污染**：下游无 tool 但收到上游 tool 块 → 2013。需 `context_mode="custom" + strip_tool_blocks_filter`
4. **max_tokens 默认 1024 硬截断**：必须显式传 16384+
5. **Anthropic 偶发 JSON 包围栏**：需剥围栏 + 鲁棒 JSON 抽取 + 正则兜底
6. **GroupChat manager 不公平 terminate**：需 fairness 硬约束（未发言者存在则强制继续）
7. **GroupChat 发言请求偶发空 cache**：发言请求自带完整历史 + 去重
8. **Skill 脚本执行必须 async**：同步 spawn 阻塞事件循环（groupchat 并发时冻死）。TS 用 `child_process.spawn` + Promise 化或 worker_threads
9. **中转代理鉴权**：`Authorization: Bearer`，非 `x-api-key`
10. **流式控制标记泄漏**：模型偶发吐 `###TASK_COMPLETED###`/`\end{document}`，落盘前剥离
11. **直答 vs 组队 JSON 起始判定**：只有以 `{"role_ids":` 或 `{"capability_ids":` 开头的 `{` 才算组队 JSON，避免直答正文里的 `body{...}`/`()=>{}` 误判。维护 24 字符尾部缓冲防跨 chunk 截断
12. **能力子 workflow 必须 `.as_agent(name=...)` 包**才能作顶层图节点

**可以简化的地方**：
1. Magentic 模式（proton 未启用，MVP 跳过，用 groupchat+handoff 覆盖）
2. checkpoint 持久化（内存态即可）
3. request_info / human-in-the-loop（后置）
4. telemetry 层（空操作或纯日志）
5. compaction_strategy / tokenizer（先用简单截断保留最近 N 条）
6. MCP 工具（后置，先支持普通 function tool）
7. a2a 远程 agent（后置，回退本地）
8. 条件边谓词（MVP 只 `contains` + 恒真）
9. WorkflowBuilder 高级边 API（先 `add_edge` + `add_fan_out_edges` + `add_switch_case_edge_group`）
10. ResponseStream 的 `.map`/`.with_*_hook`（TS 用 `AsyncIterable<Update>` + `getFinalResponse(): Promise<Response>` 等价）

### L. 关键源码文件清单（自研时直接参考）

**框架侧**（`/Users/shijianzhong/agent-framework-main` 或 `.venv` site-packages）：
- `agent_framework/_workflows/_runner.py` — Pregel superstep 执行模型
- `agent_framework/_workflows/_agent_executor.py` — context_mode/cache/should_respond 范式
- `agent_framework_anthropic/_chat_client.py` — Anthropic SDK 调用 + 消息映射 + 流式解析 + tool-use 循环
- `agent_framework_orchestrations/_group_chat.py` — manager 结构化输出 + 广播 + 路由
- `agent_framework_orchestrations/_handoff.py` — synthetic tool + middleware short-circuit
- `agent_framework_orchestrations/_magentic.py` — Magentic 调度循环（参考，不实现）

**proton 使用侧**：
- `src/proton/orchestrator/builder.py` — JSON 图→workflow 转换全范式
- `src/proton/orchestrator/runner.py` — SSE 事件映射全表
- `src/proton/orchestrator/home.py` — groupchat 公平性 patch / 唤醒中间件 / 三级记忆注入 / 两段式意图路由（见下）
- `src/proton/llm.py` — 重试策略范式

### M. 两段式意图路由（首页主助手，对应 home.py）

首页主助手不只是单 Agent 聊天，还有"直答 vs 组队"的意图路由——`home.ts` 的核心职责（TS 架构里 home.ts = 首页主助手入口：单 Agent + 意图路由 + 记忆调度）：

1. **第一阶段（直答判定）**：主 Agent 先产出，输出里若以 `{"role_ids":` 或 `{"capability_ids":` 开头的 `{` 视为组队 JSON 起始（见铁律 23，维护 24 字符尾部缓冲防跨 chunk 截断），否则为直答，直接流式回用户。
2. **第二阶段（组队执行）**：若判为组队，解析 JSON 拿 `role_ids`/`capability_ids` → 动态拼一个 sequential/groupchat 编排图 → 走 runner 执行 → 把编排流式事件转给前端。

> TS 实现注意：直答 vs 组队 JSON 起始判定务必遵守铁律 23——只有上述两个前缀的 `{` 才算组队，避免直答正文里的 `body{...}`/`()=>{}` 被误判。24 字符尾部缓冲是为了防流式 chunk 把 `{"role_ids":` 截断在两段。

---
- `src/proton/tools/registry.py` — 工具注册表 + 失败不抛异常模式

---

## 四、模块迁移映射表

| 原模块 (Python) | → 新模块 (TS) | 迁移方式 | 难度 |
|---|---|---|---|
| `main.py` 路由挂载 | `main/index.ts` 主进程入口 + IPC 注册 | 重写（HTTP→IPC） | 中 |
| `config.py` | `main/config.ts`（Zod schema） | 直译 | 低 |
| `llm.py` | `main/llm/client.ts` + `retry.ts` | 直译重试逻辑 | 中 |
| `storage.py` (2065 行) | `main/storage/` 多文件拆分 + SQLite | **重构拆分**（见 §5.2） | 极高 |
| `orchestrator/models.py` | `main/orchestrator/models.ts` | 直译 Pydantic→Zod | 中 |
| `orchestrator/builder.py` | `main/orchestrator/builder.ts` | **自研编排核心** | 极高 |
| `orchestrator/runner.py` | `main/orchestrator/runner.ts` | SSE→webContents.send | 高 |
| `orchestrator/constraints.py` | `main/orchestrator/constraints.ts` | 直译 | 低 |
| `orchestrator/home.py` | `main/orchestrator/home.ts` | 直译 | 中 |
| `api/orchestrate.py` | `main/ipc/orchestrate.ts` | HTTP→IPC | 中 |
| `api/capabilities.py` | `main/ipc/capabilities.ts` + storage | 重写 | 中 |
| `api/agents.py` / `agents_store.py` | `main/ipc/agents.ts`（角色）+ `main/ipc/persona.ts`（首页主助手人设，独立） | 重写 | 中 |
| `api/models.py` / `skills*.py` | `main/ipc/models.ts` / `skills.ts` | 重写 | 低 |
| `context/*` | AsyncLocalStorage (Node) | contextvar→ALS | 低 |
| `tools/registry.py` | `main/tools/registry.ts` | 直译 | 中 |
| 前端 `api.ts` + `api/config.ts` | `preload.ts` + 渲染层 `api/index.ts`（TanStack Query） | fetch→IPC 重写 | 中 |
| 前端 UI 全部 | **重写**（ShadCN + Tailwind） | 不复用，仅借领域知识 | 高 |
| 画布节点组件 | `renderer/components/editor/nodes/` 重写 | 视觉/交互全新，契约沿用 | 高 |

---

## 五、核心模块迁移详细方案

### 5.1 编排引擎（最核心，自研）

**目标**：用 TS 实现等价于 Microsoft Agent Framework 的编排能力。

#### 5.1.1 节点模型（对应 `orchestrator/models.py`）

```ts
// main/orchestrator/models.ts
type NodeType =
  | 'agent'        // 单 Agent
  | 'sequential'   // 顺序编排容器
  | 'concurrent'   // 并发编排容器
  | 'groupchat'    // 群聊
  | 'handoff'      // 转交
  | 'magentic';    // Magentic 多智能体

interface GraphNode {
  id: string;
  type: NodeType;
  data: NodeData;          // 各类型特有配置
  position: { x: number; y: number };  // ReactFlow 坐标
}
interface GraphEdge { source: string; target: string; condition?: string; }
interface WorkflowGraph { nodes: GraphNode[]; edges: GraphEdge[]; }
```

#### 5.1.2 Builder（对应 `orchestrator/builder.py`）

把 ReactFlow JSON 图编译为可执行 workflow。自研而非依赖框架：

```ts
// main/orchestrator/builder.ts
export function buildWorkflow(graph: WorkflowGraph): RuntimeWorkflow {
  // 1. 环检测 + 依赖关系收集（运行时拓扑序由 Pregel superstep 隐式保证，不做静态排序执行，见 §三之三 E + 铁律 7）
  // 2. 按 type 分发到不同 builder
  //    - agent      → buildAgentNode (单 Agent 调用 + 工具集)
  //    - sequential → buildSequential (配线性边 A→B→C)
  //    - concurrent → buildConcurrent (fan-out + fan-in 聚合)
  //    - groupchat  → buildGroupChat (广播 + 定向请求 + 路由策略)
  //    - handoff    → buildHandoff (条件转交)
  //    - magentic   → buildMagentic (Leader/Worker 模式)
  // 3. 条件边 → conditional routing function
  // 4. 返回 RuntimeWorkflow（DAG 执行计划）
}
```

#### 5.1.3 Runner（对应 `orchestrator/runner.py`）

> ⚠️ 事件 schema 与 §三之三 F 保持唯一一致。`shared/types.ts` 是唯一契约源，下面的事件类型即契约。

```ts
// shared/types.ts —— 编排流式事件契约（主/渲染唯一源）
type StreamEvent =
  | { type: 'node_started'; node_id: string }
  | { type: 'node_done'; node_id: string }
  | { type: 'node_error'; node_id: string; error: string }
  | { type: 'output'; node_id: string; speaker: string; text: string }
  | { type: 'tool_call'; node_id: string; tool: string; args: unknown }
  | { type: 'tool_result'; node_id: string; result: unknown }
  | { type: 'handoff'; from: string; to: string }
  | { type: 'failed'; error: string }
  | { type: 'done' };

// main/orchestrator/runner.ts
export async function runWorkflow(
  wf: RuntimeWorkflow,
  input: string,
  sessionId: string,
  onEvent: (e: StreamEvent) => void  // 替代 SSE
): Promise<RunResult> {
  // 逐 superstep 执行（Pregel 模型，见铁律 7 + §三之三 E）：
  //   drain pending messages → 按 source 分组 → Promise.all 并发 deliver → commit → 下个 superstep
  //   收敛（无新消息）后结束。同 superstep 内所有收到消息的 executor 并发执行。
  // onEvent 推送见上方 StreamEvent 联合类型。
}
```

主进程拿到 `onEvent` → `mainWindow.webContents.send('orchestrate:stream', event)`；渲染层用 `ipcRenderer.on` 订阅。**这是对原 SSE 的等价替代**。

#### 5.1.4 Agent 执行单元（替代 Agent Framework Agent）

```ts
// main/orchestrator/agent.ts
export class Agent {
  constructor(
    public config: AgentConfig,        // system prompt, tools, model
    public llm: LLMClient,
    public tools: ToolRegistry,
  ) {}
  async run(input: string, ctx: RunContext, onToken: (d: string) => void) {
    // 多轮 tool-use 循环：
    // 1. 组装 messages + system + 三级记忆注入
    // 2. stream LLM，逐 token onToken
    // 3. 若有 tool_use → 执行 → 追加 tool_result → 继续循环
    // 4. 直至 stop
  }
}
```

> 复杂度提示：GroupChat 的发言者选择策略、Handoff 的条件路由、Magentic 的 Leader 调度是 builder 的难点，迁移时务必先读透原 `builder.py` 每种类型的分支逻辑并补单元测试。

### 5.2 存储与三级记忆（最重，必须拆分）

原 `storage.py` 2065 行单文件，重写时**按职责拆分 + 升级 SQLite**。

#### 5.2.1 存储拆分

```
main/storage/
├── db.ts                  # better-sqlite3 连接 + schema 迁移
├── models.ts              # 模型配置 CRUD（原 models.json）
├── capabilities.ts        # 能力（编排图）CRUD
├── agents.ts              # 角色资源 CRUD
├── skills.ts              # 技能 CRUD
├── sessions.ts            # 会话历史（SQLite）
├── tasks.ts               # 任务历史（SQLite）
├── memory/
│   ├── l1_rolling.ts      # L1 滚动压缩（单会话内）
│   ├── l2_cross_session.ts# L2 跨会话精炼
│   └── l3_longterm.ts     # L3 长期沉淀
└── paths.ts               # app.getPath('userData') 路径管理
```

#### 5.2.2 三级记忆（原项目核心资产，务必保真）

| 层 | 作用 | 触发时机 | 实现 |
|---|---|---|---|
| L1 滚动压缩 | 单会话内消息过长时压缩前文 | 单会话 token 超阈值 | LLM 调用压缩 + SQLite 存档 |
| L2 跨会话精炼 | 跨会话提取本会话要点 | 会话结束 | LLM 调用 + 写入用户档案 |
| L3 长期沉淀 | 长期稳定用户画像/事实 | 周期/触发式 | LLM 调用 + 持久档案 |

迁移要点：先把原 `storage.py` 里 L1/L2/L3 的触发条件、压缩 prompt、精炼策略逐函数对照迁移，**这是产品差异化的核心，不能丢**。**去掉源项目的用户隔离维度**（单用户桌面应用，记忆/会话/任务不再按 user_id 分，存储层留 `user_id` 字段默认填 `"local"` 以备未来可选云同步，但不做隔离逻辑）。

#### 5.2.3 SQLite Schema（新增）

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, user_id TEXT, title TEXT,
  created_at INTEGER, updated_at INTEGER
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, session_id TEXT, role TEXT,
  content TEXT, meta JSON, created_at INTEGER
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, user_id TEXT, session_id TEXT,
  status TEXT, graph JSON, result JSON, created_at INTEGER
);
CREATE TABLE memory_l1 (session_id TEXT, summary TEXT, ts INTEGER);
CREATE TABLE memory_l2 (user_id TEXT, session_id TEXT, digest TEXT, ts INTEGER);
CREATE TABLE memory_l3 (user_id TEXT, key TEXT, value TEXT, ts INTEGER);
-- 配置类仍用 JSON 文件（models.json / capabilities/*.json）
```

### 5.3 LLM 客户端 + 重试（对应 `llm.py`）

```ts
// main/llm/retry.ts
export class RetryingClient {
  constructor(private inner: LLMClient, private opts: RetryOpts) {}
  async *stream(req: Req): AsyncIterable<Delta> {
    // 指数退避 + jitter；429/5xx/网络错误重试；流式断点续传
  }
}
```
中转地址、model_id → endpoint 映射逻辑从 `llm.py` 直译；模型配置从 `~/.eclaw/models.json` 迁到 `userData/models.json`。

### 5.4 登录 / 鉴权 / 用户隔离 —— 不迁移

本项目定位为**开源个人桌面工具**：用户自行下载安装到本机、自配 LLM key、数据存本地 `userData`。因此：

- **登录页**：不实现。原 Proton 的 `pages/Login/`、登录 assets、`useAutoLogin` hook 全部不迁移。
- **第三方认证中心对接**：不迁移。原 `middleware/auth_middleware.py`、`auth_routes.py`、`api/participant.py`、`ennunifiedcsrftoken` / `ennunifiedauthorization` header 机制全部不迁移。
- **RSA 加密**：不迁移（`jsencrypt`、`utils/rsa.ts` 不需要）。
- **用户隔离**：不实现。记忆/会话/任务历史不再按 `user_id` 分。存储层保留 `user_id` 字段默认填 `"local"`，**只作为未来可选云同步的预留位**，不做任何隔离逻辑。
- **保留**：LLM key 与中转地址的管理挪到**设置页**（用户自己填，主进程用 `crypto` 加密存 `userData`，不进渲染进程）。

### 5.5 高德地图 —— 不迁移

原 `api/amap.py`（高德安全代理）不迁移，前端不再有地图卡片（`components/AMapCard`），`@amap/amap-jsapi-loader` 不引入。若未来某场景需要地图，再单独评估。

### 5.6 前端 API 层改造（对应 `api.ts` + `api/config.ts`）

原 `fetch('/api/orchestrate/stream', ...)` SSE → 改为 IPC：

```ts
// preload.ts
contextBridge.exposeInMainWorld('one', {
  orchestrate: {
    run: (graph, input, sessionId) =>
      ipcRenderer.invoke('orchestrate:run', { graph, input, sessionId }),
    onStream: (cb) => ipcRenderer.on('orchestrate:stream', (_e, ev) => cb(ev)),
    cancel: (runId) => ipcRenderer.invoke('orchestrate:cancel', runId),
  },
  // ... 其它 API 1:1 映射
});
```
渲染层 `api/index.ts` 改为薄封装调用 `window.one.*`，业务调用点几乎不动。

---

## 六、新增原生能力（桌面化独有）

| 能力 | 实现 | 触发 |
|---|---|---|
| 多窗口 / 单例 | `app.requestSingleInstanceLock` + `BrowserWindow` | 启动 |
| 系统托盘 | `Tray` + 右键菜单（显示/退出/设置） | 常驻 |
| 全局快捷键 | `globalShortcut`（如 `CmdOrCtrl+Shift+E` 唤起） | 注册于 app.ready |
| 原生菜单 | `Menu`（文件/编辑/视图/窗口/帮助） | 默认 |
| 文件对话框 | `dialog.showOpenDialog`（导入编排图/技能） | 菜单/按钮 |
| 自动更新 | `electron-updater` + 私有/公共 update server | 启动检查 + 定时 |
| 开机自启 | `app.setLoginItemSettings` | 设置开关 |
| 通知 | `Notification`（任务完成提醒） | 编排结束 |
| 深色模式跟随 | `nativeTheme` | 系统切换 |
| 应用内日志查看 | `electron-log` + 设置页查看 | 设置 |
| 窗口标题栏 | macOS `titleBarStyle: 'hiddenInset'`（保留红绿黄、不占标题栏高度）+ `-webkit-app-region: drag` 设拖动区（`IconRail` 顶部 + `MainArea` 顶部边缘，按钮/输入区 `no-drag`）；Win/Linux `frame: false` + 自绘最小化/关闭按钮或用默认标题栏 | 启动（平台分支） |

---

## 七、目标项目结构

```
one/
├── package.json
├── electron-builder.yml          # mac/win/linux 三平台配置
├── electron.vite.config.ts       # electron-vite 一体化配置
├── tsconfig.json
│
├── src/
│   ├── main/                     # 主进程（原 Python 后端）
│   │   ├── index.ts             # 入口：窗口/托盘/快捷键/自动更新
│   │   ├── config.ts            # Zod 配置
│   │   ├── ipc/
│   │   │   ├── index.ts         # ipcMain.handle 注册中心
│   │   │   ├── orchestrate.ts
│   │   │   ├── capabilities.ts
│   │   │   ├── agents.ts        # 角色资源（可编排的多个 agent）
│   │   │   ├── persona.ts       # 首页主助手人设（与角色区分：主助手是固定人格，角色是可编排单元）
│   │   │   ├── models.ts
│   │   │   ├── skills.ts
│   │   │   ├── sessions.ts      # 会话历史
│   │   │   └── tasks.ts         # 任务历史
│   │   ├── orchestrator/        # 自研编排引擎（@one/orchestrator 逻辑名，非独立 npm 包）
│   │   │   ├── models.ts        # 图模型 + StreamEvent 契约（与 shared/types.ts 同步）
│   │   │   ├── builder.ts       # JSON 图 → RuntimeWorkflow（环检测+配边，不做静态排序）
│   │   │   ├── runner.ts        # Pregel superstep 主循环（非递归）
│   │   │   ├── agent.ts        # 单 Agent 执行单元（tool-use 循环借力 Anthropic SDK）
│   │   │   ├── constraints.ts  # output_constraints 解析 + contains: 条件边谓词
│   │   │   ├── home.ts         # 首页主助手入口（单 Agent + 意图路由 + 记忆调度）
│   │   │   └── patterns/       # builder 配图逻辑（非递归调度器）
│   │   │       ├── sequential.ts / concurrent.ts
│   │   │       ├── groupchat.ts / handoff.ts
│   │   │       └── magentic.ts # MVP 占位，跳过
│   │   ├── llm/
│   │   │   ├── client.ts
│   │   │   └── retry.ts
│   │   ├── storage/
│   │   │   ├── db.ts
│   │   │   ├── sessions.ts
│   │   │   ├── tasks.ts
│   │   │   ├── memory/
│   │   │   └── ...
│   │   ├── secrets/              # LLM key 等本地加密存储（Node crypto 加密文件，跨平台）
│   │   │   └── vault.ts
│   │   ├── tools/
│   │   │   └── registry.ts
│   │   └── context.ts           # AsyncLocalStorage
│   │
│   ├── preload/
│   │   └── index.ts             # contextBridge 白名单
│   │
│   ├── renderer/                # 渲染进程（前端重写）
│   │   ├── index.html
│   │   ├── src/
│   │   │   ├── main.tsx
│   │   │   ├── App.tsx          # hashRouter + 布局壳
│   │   │   ├── routes/          # 路由树
│   │   │   ├── pages/           # 全部重写（HomePage/EditorPage/...）
│   │   │   ├── features/        # 按业务领域组织
│   │   │   │   ├── chat/        # 聊天：消息流/输入框/流式渲染
│   │   │   │   ├── editor/      # 画布：NodeInspector/NodePalette/nodes
│   │   │   │   ├── agents/      # 角色管理
│   │   │   │   ├── skills/      # 技能管理
│   │   │   │   ├── models/      # 模型配置
│   │   │   │   └── settings/    # 设置（含 LLM key 管理）
│   │   │   ├── components/       # 通用 UI（基于 ShadCN）
│   │   │   ├── hooks/
│   │   │   ├── api/             # window.one 薄封装 + TanStack Query
│   │   │   ├── store/           # Zustand
│   │   │   ├── styles/          # Tailwind v4 + 主题 token
│   │   │   └── lib/             # utils
│   │   （renderer 不单独放 vite.config.ts，配置统一写在根 electron.vite.config.ts）
│   │
│   └── shared/                  # 主/渲染共享类型
│       └── types.ts
│
└── resources/                   # 图标/托盘图/许可证
```

---

## 八、分阶段实施计划

> 编号 0~7 连续，按依赖顺序排列。阶段 5（前端 UI）可与阶段 1~4 后端工作**并行**推进，后端模块就绪即可联调对应页面。

### 阶段 0：脚手架与基础设施（1 周）

- [ ] `electron-vite` 初始化主/preload/渲染三端工程
- [ ] tsconfig + electron-builder.yml（先 mac 本地）
- [ ] 主进程最小窗口 + preload 白名单 + 一个 hello IPC 通路
- [ ] Tailwind v4 + ShadCN UI 基础接入，主题 token（纯白通透/夜色）+ 品牌色（薄荷绿）+ 玻璃配方变量
- [ ] react-router v7 hashRouter 壳 + 全局布局骨架（`IconRail` + `SideList` + `MainArea` + `Inspector` 浮动槽位 + `CommandPalette` 槽位，见 UI_BRIEF §0.1）
- [ ] Zustand + TanStack Query 接入
- [ ] `electron-log` 接入
- [ ] 测试脚手架：vitest（主进程单测）+ Playwright Electron（E2E）配置就绪（见 §十）
- [ ] i18n 脚手架：`i18next` + `react-i18next` 接入，`locales/{zh-CN,en}/common.json` 初始化（见 §十二）
- [ ] 错误兜底：主进程 `uncaughtException`/`unhandledRejection` + 渲染层 `window.onerror` 全局处理器（见 §十一）

**里程碑 M0**：桌面壳能打开，主题化骨架页渲染，IPC 双向通路通，测试 + i18n 脚手架就绪。

### 阶段 1：存储与配置（1 周）

- [ ] `better-sqlite3` 接入 + schema 迁移
- [ ] 配置模块（Zod）+ models.json 迁移
- [ ] `secrets/vault.ts`（Node crypto 加密 LLM key）
- [ ] 存储 CRUD：models / capabilities / agents（角色）/ skills / persona（首页主助手人设，独立于角色）
- [ ] IPC 暴露 + 渲染层 `api/` 改造，管理后台页面先打通

**里程碑 M1**：模型配置、角色、技能、能力列表页能用（只读+增删改）。

### 阶段 2：LLM 与单 Agent 聊天（1 周）

- [ ] LLM 客户端 + 重试包装（直译 `llm.py`，重试包在 `LLMClient.stream()` 外层，见铁律 10）
- [ ] 单 Agent 执行（含 tool-use 循环，借力 Anthropic TS SDK `beta.messages.stream()`）
- [ ] 流式 token 经 `webContents.send` → 渲染层渲染
- [ ] 首页主助手聊天页打通（不含记忆）

**里程碑 M2**：首页能跟主助手多轮对话，流式输出 + 工具调用。

### 阶段 3：三级记忆（1.5 周，高风险）

- [ ] L0 身份块（从设置页"个人档案"取，见 DESIGN §9.4）
- [ ] L1 滚动压缩（含压缩 prompt 迁移；受阻可先用简单截断兜底）
- [ ] L2 跨会话精炼
- [ ] L3 长期沉淀（`memory_recall`/`memory_search` 工具）
- [ ] 会话/任务历史 SQLite 表 + 查询页
- [ ] 与 Agent Framework compaction 的关系厘清（L1 会话级摘要存 SQLite，compaction 是 agent 运行时窗口截断，二者层级不同）

**里程碑 M3**：多会话后记忆生效，任务进度页可用。

### 阶段 4：编排引擎（2 周，最高风险）

> ⚠️ 最紧的阶段。若超期，拆 4a（Sequential+Concurrent+Agent 叶子，1 周）+ 4b（GroupChat 四 patch + Handoff middleware + Pregel 并发，2 周）分批验收。

- [ ] 图模型 + builder（5 种模式逐类型实现，Pregel 模型不是递归，见 §三 D）
- [ ] runner（superstep 循环 + `Promise.all` 并发 deliver + 收敛判断，见 §三之三 E + §5.1.3）
- [ ] 条件边路由（`contains:` 谓词 + `add_switch_case_edge_group`）
- [ ] GroupChat 四个 patch（cache/dedup/fairness/output）
- [ ] Handoff synthetic tool + middleware 短路
- [ ] 画布编辑器（NodeInspector/NodePalette/nodes）联调
- [ ] **每种编排模式补单元测试**（对照原 builder.py 行为，黄金用例见 §三 E）

**里程碑 M4**：画布编排能跑 Sequential/Concurrent/GroupChat/Handoff 全部；Magentic 降级提示"改用 groupchat+handoff 覆盖"（MVP 跳过，见 §三之三 K#1）。

### 阶段 5：前端 UI 重写（并行，3 周）

> 与阶段 1~4 后端工作并行推进。所有页面从零重写，不复用原 UI。视觉按 [`UI_BRIEF.md`](./UI_BRIEF.md)，令牌按 [`DESIGN.md`](./DESIGN.md) §2.1。

- [ ] **设计令牌与基础组件**：色板/间距/圆角/阴影/动效曲线；Button/Input/Dialog/Drawer/Toast/Tabs/Table 等 ShadCN 基础组件定制
- [ ] **主题系统**（详见 DESIGN §12 + §12.6.1）：预设/明暗/点缀色/背景图（主进程 dialog 选图+压缩+imageId）/玻璃参数/密度/字号/对比度兜底/防首屏闪白；落地清单见 §12.8
- [ ] **首页主助手聊天**：消息流（用户/AI 气泡差异化）、流式光标、Markdown/代码块/公式重做样式、工具调用卡片、停止/重发
- [ ] **能力编排画布**：自定义节点视觉（Agent/Sequential/Concurrent/groupchat/Handoff/magentic 六类节点卡片）、NodeInspector 抽屉、NodePalette、连线与条件边交互、运行态高亮
- [ ] **能力列表 / 角色 / 技能 / 模型 / 人设 / 任务进度**：统一表格+表单范式，空态/加载态/错误态规范
- [ ] **设置页**：个人档案/外观（主题系统全量）/LLM 配置/快捷键/开机自启/日志查看
- [ ] **CommandPalette（⌘K）**：全局导航/搜索/动作入口（UI_BRIEF §6）
- [ ] **i18n 全量**：所有硬编码中文替换为 `useTranslation` key；`home/editor/settings/errors` namespace 补齐；日期用 `Intl` 格式化（见 §十二）
- [ ] 微动效（Framer Motion）：消息进入、抽屉开合、节点选中、任务进度

**里程碑 M5**：核心页面视觉与交互重写完成，主题系统可用，后端就绪部分可联调。

### 阶段 6：原生能力与打磨（1 周）

- [ ] 托盘 + 全局快捷键 + 原生菜单
- [ ] 自动更新（electron-updater）
- [ ] 通知 + 开机自启 + 明暗跟随系统（`nativeTheme`）
- [ ] **崩溃恢复**：`crashReporter` + 启动哨兵检测上次崩溃 + 草稿恢复提示（见 §十一.5/.7）
- [ ] **存储恢复**：SQLite WAL + integrity_check + 损坏备份恢复（见 §十一.4）
- [ ] 打包 mac/win，安装包验证

**里程碑 M6**：可分发的双平台安装包，自动更新闭环。

### 阶段 7：工具与 MCP（持续）

- [ ] 内置工具 TS 重写（shell / 文件 / grep / glob / browser_use / desktop_screenshot）
- [ ] MCP 工具协议接入（@modelcontextprotocol/sdk）
- [ ] 即梦文生图等外部工具

---

## 八之二、附录：路由表与 IPC 契约

### A. 路由表（react-router v7 hashRouter）

| 路径 | 页面 | IconRail 项 | 说明 |
|---|---|---|---|
| `/` | 首页主助手聊天 | 首页 | 默认入口，单 Agent + 意图路由 + 三级记忆 |
| `/editor/:capabilityId` | 能力编排画布 | 画布 | ReactFlow 编辑器，`:capabilityId` 为空时新建 |
| `/agents` | 角色管理 | 角色 | 角色列表 + 编辑抽屉 |
| `/skills` | 技能管理 | 技能 | 技能列表 + 编辑 |
| `/models` | 模型配置 | 模型 | 模型/中转地址配置 |
| `/tasks` | 任务进度 | 任务 | 编排运行态历史 |
| `/settings` | 设置 | 设置 | 个人档案/外观/LLM/快捷键/自启/关于 |

> 命令面板（⌘K）的"导航"分组跳转到上述路径；"动作"分组触发新建编排/切模型/清空会话等。

### B. IPC 契约（`window.one.*` 命名空间）

> preload 通过 `contextBridge` 暴露，渲染层只调 `window.one.*`。所有方法返回 Promise，流式用事件回调。签名放 `shared/types.ts`，主进程 `ipcMain.handle` 对应实现。

```ts
window.one = {
  // —— 编排 ——
  orchestrate: {
    run(graph, input, sessionId): Promise<{ runId: string }>,
    onStream(cb: (e: StreamEvent) => void): () => void,  // 返回取消订阅
    cancel(runId: string): Promise<void>,
  },

  // —— 能力（编排图） ——
  capabilities: {
    list(): Promise<Capability[]>,
    get(id): Promise<Capability | null>,
    save(cap: Capability): Promise<Capability>,
    remove(id): Promise<void>,
    runStream(id, input, sessionId, cb): Promise<RunResult>,  // 会话流式
    loadSession(capId, sessionId): Promise<Session>,
    listSessions(capId): Promise<Session[]>,
  },

  // —— 角色 / 技能 / 模型 / 人设 ——
  agents: { list, get, save, remove },        // 角色资源（可编排的多个 agent）
  skills: { list, get, save, remove },
  models: { list, get, save, remove },        // model_id → endpoint/key 配置
  persona: { get, save },                     // 首页主助手人设（独立于角色，对应 main/ipc/persona.ts）

  // —— 会话 / 任务历史 ——
  sessions: { list, get, remove, rename },
  tasks: { list, get, cancel },

  // —— LLM key 安全存储 ——
  secrets: {
    getLLMConfig(modelId): Promise<{ baseUrl, apiKey?, defaultModel }>,
    setLLMConfig(modelId, cfg): Promise<void>,  // apiKey 经主进程 crypto 加密存 userData
    testLLM(modelId): Promise<{ ok, error? }>,
  },

  // —— 主题 ——
  theme: {
    get(): Promise<ThemeConfig>,
    set(cfg: ThemeConfig): Promise<void>,
    pickBackground(): Promise<{ filePath: string } | null>,        // 主进程 dialog 选图，返回绝对路径
    setBackgroundPath(filePath: string): Promise<{ ok: boolean; error?: string }>,  // 校验本地路径
    importBackground(filePath: string): Promise<{ imageId: string }>,  // 复制压缩到 userData/bg/
    loadBackground(bg: BackgroundConfig): Promise<{ dataUrl: string | null; stale?: boolean }>,  // 取 dataURL（path 失效返 stale）
    removeBackground(imageId?: string): Promise<void>,             // imported 删副本；path 只清配置
    onSystemModeChange(cb: (mode) => void): () => void,  // nativeTheme 跟随
  },

  // —— 原生 ——
  app: {
    setAutoLaunch(on: boolean): Promise<void>,
    showInFolder(path): Promise<void>,
    relaunch(): void,
  },
};
```

> 实现时按命名空间拆 `main/ipc/{orchestrate,capabilities,agents,skills,models,sessions,tasks}.ts` + `main/theme/` + `main/secrets/`，preload 统一聚合成 `window.one`。

---

## 九、风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| **编排引擎自研** | ★★★★★ 行为不等价 | 先冻结原 `builder.py` 6 种节点行为作黄金用例；逐类型迁移 + 单元测试对照；优先 Sequential，GroupChat/Magentic 放最后 |
| **三级记忆保真** | ★★★★ 产品差异化丢失 | 把 `storage.py` 的 prompt 与触发逻辑逐行对照迁移；准备回归用例（多会话记忆断言） |
| **better-sqlite3 原生编译** | ★★★ 打包体积/架构兼容 | 用 prebuild 二进制；electron-rebuild 集成到构建；或备选 `@electron-lib/sqlite` |
| **自动更新基础设施** | ★★ 需服务器 | 起步可先用 github releases；正式分发再上私有 update server |
| **前端 fetch→IPC 改造面广** | ★★ 漏改 | 渲染层 `api/index.ts` 收口为唯一出口，业务代码只调它，改一处不改调用点 |
| **前端 UI 重写工作量大** | ★★★ 全部页面从零 | 用 ShadCN + Tailwind 收敛基础组件，复用领域知识；画布节点视觉重写但契约沿用；与后端并行，后端就绪即联调 |
| **画布节点视觉与编排引擎契约耦合** | ★★ 联调反复 | 主/渲染共享 `shared/types.ts`（图模型 + 事件 schema）作为单一契约源 |
| **ShadCN + Tailwind v4 兼容** | ★★ 主题化/组件初始化需额外适配 | Tailwind v4 是 CSS-first 重写，ShadCN 默认模板基于 v3；先接入 v4，遇阻可 fallback 到 v3（仅影响样式工程，不碰架构） |
| **react-router file:// 兼容** | ★ | 改 hashRouter 即可 |

---

## 十、测试策略

> 分四层，从内到外。编排引擎是核心，单元测试 + 黄金用例是硬要求；其它层按阶段递进。

### 10.1 单元测试（vitest）—— 核心，强制

| 模块 | 测试要点 | 黄金用例来源 |
|---|---|---|
| 编排 builder | 5 种节点类型建图、条件边 `contains:` 求值、环检测、容器 `.as_agent()` 包裹 | 对照原 `builder.py` 逐类型行为（§三 E） |
| 编排 runner | Pregel superstep 收敛、同 superstep 并发（`Promise.all`）、should_respond 双语义、失败节点不中断其它分支 | 原项目输入图 + 期望事件序列 |
| GroupChat 四 patch | cache_patch（空 cache 治 2013）、dedup_patch、manager_fairness_patch（未发言强制继续）、manager_output_patch（剥围栏） | 原 `home.py` patch 行为 |
| Handoff | synthetic tool 短路、`MiddlewareTermination`、扫 function_result 解析 target | 原 `_handoff.py` |
| 重试客户端 | 429/5xx 重试、退避 1/2/4s + ±20% jitter、401/400 不重试、网络异常识别 | 原 `llm.py` 策略 |
| 工具注册表 | 失败返回 JSON 不抛、重试 3 次、schema 显式构造 | 原 `tools/registry.py` |
| 三级记忆 L1/L2/L3 | 触发条件、压缩 prompt 调用、最近窗口原文拼接、限长 | 原 `storage.py` |
| 主题 applyTheme | 点缀色 OKLCH 派生 300/400/600、glassTint/glassOpacity→CSS 变量、density 系数、背景图 dataURL 写入 | DESIGN §12 |
| 点缀色派生 | hex→oklch→提亮/压暗 6%/12% | DESIGN §12.5 |

### 10.2 契约测试（shared/types.ts）—— 防前后端各实现一半

- `StreamEvent` 联合类型 + Zod schema 双向校验：主进程 emit 的事件、渲染层 `onStream` 收的事件，schema 必须匹配。
- `ThemeConfig`、IPC 签名（§八之二 B）同样用 Zod 在 IPC 边界校验，防渲染层传错参数。
- CI 跑 `tsc --noEmit` + Zod schema 测试，类型不通过阻塞合并。

### 10.3 集成测试（IPC + 存储 + mock LLM）

- 主进程 `ipcMain.handle` + `better-sqlite3` 真实存储，LLM 用 mock client（返回固定流式 token + tool_use 序列）。
- 测 `window.one.orchestrate.run` → onStream 事件序列 → cancel → 数据落盘。
- 测 `window.one.theme.set` → userData/theme.json 持久化 → 重启加载一致。
- 测 `window.one.secrets.setLLMConfig` → key 加密存盘 → getLLMConfig 解密一致。

### 10.4 E2E（Playwright + Electron）—— 关键用户流

Electron 官方支持 Playwright 驱动真实窗口。覆盖关键流：
1. 首页聊天：输入 → 流式输出 → 工具调用卡片 → 多轮 → 会话保存。
2. 能力编排：新建能力 → 拖节点 → 连边 → 运行 → 事件高亮 → 结果落盘。
3. 主题换肤：设置页改点缀色/背景图 → 实时预览 → 保存 → 重启一致。
4. 设置：填 LLM key → 测试连通 → 保存。
5. 崩溃恢复：强杀进程 → 重启 → 恢复未保存草稿提示。

### 10.5 测试纪律

- **每个阶段里程碑都含测试交付项**（见 §八 阶段任务里的"补单元测试"）。
- 编排引擎 PR 必须附黄金用例断言，否则不合并。
- LLM 调用在单元/集成层一律走 mock，E2E 才可选真调（用 cheap 模型）。
- 覆盖率门槛：编排引擎 ≥ 85%，记忆 ≥ 80%，其它 ≥ 60%。

---

## 十一、错误处理与崩溃恢复

### 11.1 LLM 调用错误

- **重试**（铁律 10）：429/5xx/网络异常，退避 1/2/4s + jitter，最多 3 次。
- **重试耗尽降级**：不抛异常，返回结构化错误对象给 agent，agent 把错误作为 `tool_result` 或输出告知用户，不进入死循环（铁律 11）。
- **中转网关报错兜底**：异常类型名/消息含 `backend returned`/`overloaded`/`rate limit` 等关键词也重试（原 `llm.py` 策略）。
- **401/400/ValidationError 不重试**：直接返回错误，渲染层提示"模型配置有误/鉴权失败"。

### 11.2 编排执行错误

- **单节点失败默认不中断整图**：失败 executor emit `node_error` 事件后不再 emit，Pregel 模型天然让其它分支继续。前端标记该节点红色。
- **关键路径失败才整体 failed**：入口节点或唯一汇聚点失败 → emit `failed` 事件，编排终止。
- **超时**：单节点设默认超时（如 120s），超时按 `node_error` 处理；编排整体可配 `max_duration`。
- **OOM/异常**：try/catch 包 Executor.handle，异常转 `node_error` 事件，不崩主进程。

### 11.3 IPC 错误

- 所有 `ipcMain.handle` 统一 try/catch，错误序列化成 `{ code: string; message: string; retryable: boolean }` 经 preload 返回渲染层，不抛未捕获异常。
- 渲染层 `api/` 封装统一识别 `retryable: true` 时自动重试一次 + Toast 提示。
- 渲染层用 TanStack Query 的 `onError` 全局兜底，避免每个调用点各写错误处理。

### 11.4 存储崩溃恢复

- **SQLite WAL 模式**：`PRAGMA journal_mode=WAL`，写操作事务包裹，防写一半断电损坏。
- **启动校验**：每次启动跑 schema 迁移 + 完整性检查（`PRAGMA integrity_check`）。
- **损坏恢复**：检测到库损坏 → 备份当前坏库为 `one.db.corrupt-<ts>` → 从 `one.db.bak`（周期备份）恢复 → 无备份则重建空库 + 提示用户。
- **记忆/会话落盘**：用事务，要么全写入要么不写，不留半截状态。
- **JSON 配置文件**：写入用临时文件 + rename 原子替换，防覆盖中途崩溃。

### 11.5 主进程崩溃

- `app.on('render-process-gone' / 'child-process-gone')` 监听渲染/子进程崩溃，记录后给用户"重载/退出"选项。
- `crashReporter.start()` + `electron-log` 把崩溃栈写到 `userData/logs/main-<date>.log`。
- **未捕获异常兜底**：主进程 `process.on('uncaughtException' / 'unhandledRejection')` 记日志 + 友好提示，不静默退出。渲染进程 `window.addEventListener('error' / 'unhandledrejection')` 同样兜底，不白屏。
- **崩溃上报（可选）**：开源项目默认不上报，设置页提供"匿名上报崩溃栈"开关，用户主动开启才上报。

### 11.6 流式中断恢复

- 用户中断/关闭窗口：已产出 token 保留在会话，状态标 `interrupted`，重开可"继续生成"（续跑同 session）。
- 主进程持有 AbortController，渲染层 `orchestrate.cancel(runId)` 触发 abort，runner 在下个 superstep 检查并优雅停止。

### 11.7 草稿恢复

- 编排画布编辑、聊天未发送输入、设置未保存改动——都以"草稿"形式 debounce 落盘 `userData/drafts/`。
- 启动时检测上次是否异常退出（写一个 `userData/.running` 哨兵文件，正常退出删，启动时存在=上次崩溃）→ 提示"恢复未保存草稿"。

---

## 十二、国际化（i18n）

> 开源项目，默认中文，但 i18n 从一开始就做，比后期 retrofit 便宜 10 倍。主要面向中文用户，en 为对等第二语言。

### 12.1 技术方案

- **库**：`react-i18next` + `i18next`（渲染层）；主进程错误消息返回 i18n key 而非硬编码中文，渲染层翻译。
- **默认语言**：`zh-CN` 默认 + `en` 对等。跟随系统语种（首次启动）+ 设置页可改。
- **命名**：key 用点分命名空间，如 `home.chat.inputPlaceholder`、`editor.node.agent`、`settings.appearance.theme`。
- **资源组织**：`renderer/src/locales/{zh-CN,en}/`，按 namespace 分文件：`common.json` / `home.json` / `editor.json` / `settings.json` / `errors.json`。
- **加载**：按 namespace 懒加载（i18next `addResourceBundle`），首屏只加载 `common` + 当前页 namespace。

### 12.2 不翻译的

- LLM 模型名、API 字段名、工具名、`executor_id`。
- 节点视觉标签（"序/并/群聊"）——可作为 i18n 资源，zh 用中文、en 用 `SEQ/PAR/GROUP`。
- 代码/日志。

### 12.3 日期/数字

- 用 `Intl.DateTimeFormat` / `Intl.NumberFormat`，按当前语种格式化，不用 dayjs 写死格式。
- 相对时间（"3 分钟前"）用 `Intl.RelativeTimeFormat`。

### 12.4 语种与 agent

- 设置页"个人档案"（§9.4）加"偏好语种"选项，作为 L0 身份块的一部分注入 agent system prompt，影响 agent 回复语言。
- agent 回复语言 ≠ UI 语言，二者独立（用户可能 UI 中文、要 agent 用英文回复）。

### 12.5 与主题/字体的关系

- i18n 不碰字体/字号（`fontScale` 和字体选择在主题系统，DESIGN §12）。
- 中英文字体已在 DESIGN §三 定义（Inter + 思源黑体），i18n 切换不换字体。

### 12.6 落地任务

- [ ] `i18next` + `react-i18next` 接入
- [ ] `locales/{zh-CN,en}/` 目录 + `common/home/editor/settings/errors` 五个 namespace
- [ ] `useTranslation` 替换所有硬编码中文（首屏 + 各页）
- [ ] 主进程错误消息改返回 i18n key（`errors.*`）
- [ ] 设置页"偏好语种"控件 + 持久化
- [ ] `Intl.DateTimeFormat`/`RelativeTimeFormat` 接入任务/会话时间
- [ ] 首次启动跟随系统语种

---

## 十三、验收标准（DoD）

1. 三平台（mac/win/linux）可产出安装包并本地安装运行
2. 首页主助手多轮对话 + 流式 + 三级记忆生效（多会话回归用例通过）
3. 画布编排 5 种模式（Sequential/Concurrent/GroupChat/Handoff；Magentic 降级）全部可执行，行为与原项目黄金用例等价
4. 托盘/快捷键/自动更新/通知闭环
5. **测试**：单元测试覆盖率达标（编排 ≥85% / 记忆 ≥80% / 其它 ≥60%）；编排黄金用例全绿；E2E 5 条关键流通过
6. **错误恢复**：SQLite 损坏可恢复；强杀后重启提示恢复草稿；IPC 错误统一结构化；主进程崩溃有日志无静默退出
7. **i18n**：zh-CN/en 双语完整；首次启动跟随系统语种；设置页可改语种；日期用 Intl 格式化
8. 应用包体积可接受（目标 < 200MB，含 Electron 运行时）

---

## 附：原项目关键文件速查（迁移时对照）

| 关注点 | 原文件 |
|---|---|
| 后端入口 | `src/proton/main.py` |
| 持久化与记忆 | `src/proton/storage.py`（2065 行，必拆） |
| LLM 客户端 | `src/proton/llm.py` |
| 配置 | `src/proton/config.py` |
| 编排图模型 | `src/proton/orchestrator/models.py` |
| 编排构建 | `src/proton/orchestrator/builder.py` |
| 编排执行 | `src/proton/orchestrator/runner.py` |
| 编排 API | `src/proton/api/orchestrate.py` |
| 前端入口 | `frontend/src/App.tsx` |
| 前端 API 层 | `frontend/src/api.ts` + `api/config.ts` |
| 画布编辑器 | `frontend/src/pages/CapabilityEditorPage.tsx` + `components/editor/` |
| 前端依赖 | `frontend/package.json` |
| 后端依赖 | `pyproject.toml` |
