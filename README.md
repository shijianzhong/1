# One

**English** | [中文](#中文)

---

A multi-agent orchestration desktop application. Create agents, skills, and capabilities — wire them into collaborative workflows with 6 orchestration patterns.

## Features

- **Direct Chat** — Ask questions, get analysis and suggestions from the main assistant
- **Team Orchestration** — Dynamically compose multi-agent teams and run collaborative workflows
- **Asset Creation** — Create agents, capabilities, skills, and personas through natural conversation
- **Long-term Memory** — Remember preferences and context across sessions
- **File Operations** — Read, write, and search local files within a sandboxed directory
- **Web Access** — Real-time web search and page content reading
- **Skill Packs** — Import reusable knowledge packages (`.zip`) with scripts and references
- **Canvas Editor** — Visual workflow editor powered by ReactFlow for designing orchestration graphs

## Orchestration Patterns

| Pattern | Description |
|---------|-------------|
| Agent | Single agent execution |
| Sequential | Chain A → B → C |
| Concurrent | Parallel fork + aggregator |
| GroupChat | Round-robin or manager-selected speaker |
| Handoff | Relay-style task transfer |
| Magentic | Manager + workers |

## Tech Stack

- **Shell**: Electron
- **Frontend**: React, TypeScript, Vite
- **Backend**: Full TypeScript, Electron IPC (no HTTP server), SQLite (better-sqlite3)
- **Canvas**: ReactFlow
- **Styling**: CSS custom properties, glass-morphism design system
- **LLM**: Multi-provider support with thinking/retry/HITL

## Architecture Highlights

A self-built orchestration kernel — not a LangChain wrapper — engineered for semantic fidelity, resilience, and zero-trust security.

- **Self-built Pregel engine** — Wavefront/BFS superstep execution (emit at step *N*, deliver at *N+1*) with concurrent fan-out per layer, a 50-superstep infinite-loop fuse, and a fan-in barrier that survives partial node failures. Four orchestration patterns implemented with semantic fidelity; GroupChat ships all four correctness patches (cache, dedup, fairness, manager-output).
- **Streaming intent router** — A 24-char tail-buffer state machine decides in real time, across chunk boundaries, whether the main agent is answering directly or emitting a team-formation JSON command — so partial answers never leak to the user as text.
- **Resilient LLM layer** — The retry decorator wraps the *actual* request method (not the top-level call), making 429/5xx back-off impossible to bypass. `max_tokens` is always sourced from agent config `defaultOptions` (with an explicit 16384 default), never left to Anthropic's implicit API default — structurally eliminating its silent 1024-token truncation. Three-tier thinking support (policy gating → native `thinking_delta` → `<think>`-tag fallback for proxies that tunnel reasoning as text, including orphan-close-tag recovery).
- **Multi-provider via one seam** — A single `LLMProtocol` interface unifies Anthropic-native and OpenAI-compatible endpoints (DeepSeek, etc.) with shared retry, thinking, and tool-use semantics — including suspended-start tool-id reconciliation and cross-provider stop-reason normalization.
- **Three-tier memory** — L0 identity → L1 rolling session summary → L2 cross-session digests → L3 on-demand fact retrieval. Each layer has a distinct injection point and injection discipline; L3 is a *passive tool* activated by prompt policy rather than hard-stuffed into context. The "no-vector on L3" decision is evidence-driven (measured FTS 59.1% > vector 36.4%).
- **Zero-trust IPC** — Every `ipcMain.handle` routes through a `withHandler` wrapper returning a typed `IpcResult<T>` discriminated union; no uncaught rejection ever reaches the renderer. Atomic JSON writes (temp + rename) protect config, vault, and crash drafts from half-written state.
- **Crash recovery & self-healing storage** — A `.running` sentinel + debounced draft persistence + a restore dialog closed the crash-recovery loop. SQLite runs WAL with `integrity_check`, 30-min periodic backups, exit `.bak`, and corruption auto-restore (WAL checkpoint *before* copy — the subtle bit that prevents "fake backups").
- **Sandboxed by default** — `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`; preload forced to CJS output (the sandbox has no ESM loader). LLM keys live in the OS keychain via `safeStorage` — plaintext never round-trips to the renderer.
- **Hybrid vector knowledge base** — FTS5 BM25 + flat-index vectors fused via RRF, with a transformers.js v4 WASM-in-Node recipe (ONNX runtime injection + custom cache + manual pooling) that runs cross-platform without native compilation.
- **Orchestration-as-data** — A content production pipeline ships as a serialized `Capability` graph, not code; users can open it on the canvas and rearrange the six-stage workflow. A GitHub-backed registry (no hosted backend) provides browse/import/auto-PR/one-click-update with non-destructive local-edit preservation and recursive dependency remapping.
- **i18n & theming from day one** — multi-namespace locales with zh-CN/en kept fully in sync; main-process errors carry i18n keys for renderer-side translation. Brand color derivation runs in OKLCH perceptual space (not RGB shifting) to keep the glass aesthetic clean.

## Getting Started

```bash
# Install dependencies
npm install

# Development
npm run dev

# Build
npm run build

# Package (DMG / installer)
npm run package
```

## Project Structure

```
src/
├── main/          # Electron main process (IPC + tools + orchestrator, no HTTP backend)
│   ├── ipc/       # IPC handlers (agents, skills, capabilities, secrets...)
│   ├── llm/       # LLM client, retry, thinking parser
│   ├── orchestrator/  # Home router, workflow runner
│   │   └── patterns/  # 6 orchestration executors
│   ├── tools/     # Built-in tools (file, web, memory, create, askUser, opencli)
│   └── secrets/   # Vault (keychain-backed credential storage)
├── renderer/      # React frontend
│   ├── src/
│   │   ├── pages/     # HomePage, EditorPage
│   │   ├── components/ # MessageItem, MentionComposer, RunChatPanel...
│   │   ├── store/     # Zustand stores
│   │   └── api/       # IPC client, hooks
│   └── public/locales/ # i18n (zh-CN, en)
└── shared/        # Shared types (Agent, Skill, Capability, Persona...)
```

---

<a id="中文"></a>
## 中文

多 Agent 编排桌面应用。创建角色、技能与能力，通过 6 种编排模式组建协作工作流。

### 核心能力

- **直接对话** — 主助手回答问题、提供分析和建议
- **团队编排** — 动态组建多 Agent 团队，运行协作工作流
- **资产创建** — 通过自然对话创建角色、能力、技能和人设
- **长期记忆** — 跨会话记住偏好和上下文
- **文件操作** — 在围栏目录内读写和搜索本地文件
- **联网搜索** — 实时全网搜索和网页内容读取
- **技能包** — 导入可复用知识包（`.zip`），含脚本和参考资料
- **画布编辑器** — 基于 ReactFlow 的可视化工作流编辑器

### 编排模式

| 模式 | 说明 |
|------|------|
| Agent | 单 Agent 执行 |
| Sequential | 顺序链 A → B → C |
| Concurrent | 并行分叉 + 聚合 |
| GroupChat | 群聊（轮询或管理员选发言人） |
| Handoff | 接力转交 |
| Magentic | Manager + Workers |

### 技术栈

- **外壳**：Electron
- **前端**：React、TypeScript、Vite
- **后端**：全 TypeScript、无 HTTP 服务层（Electron IPC 直连）、SQLite（better-sqlite3）
- **画布**：ReactFlow
- **样式**：CSS 自定义属性、玻璃拟态设计系统
- **LLM**：多供应商支持，含思考链/重试/人机交互

### 架构亮点

自研编排内核——非 LangChain 套壳——为语义保真、韧性与零信任安全而设计。

- **自研 Pregel 引擎**——Wavefront/BFS 层式 superstep 执行（第 *N* 步 emit、第 *N+1* 步 deliver），同层并发扇出、50 superstep 防死循环熔断、容错 fan-in 栅栏。四模式语义保真落地；GroupChat 四补丁齐全（cache / dedup / fairness / manager-output）。
- **流式意图路由**——24 字尾部缓冲状态机实时判定主助手是直答还是输出组队 JSON，跨 chunk 边界不漏判，直答片段永不误泄为正文。
- **韧性 LLM 层**——重试装饰器包裹*真正发请求的方法*（非顶层调用），429/5xx 退避无法被绕过。`max_tokens` 始终取自 Agent 配置的 `defaultOptions`（带显式 16384 缺省），绝不落空给 Anthropic 隐式 API 默认值——结构性杜绝 1024 token 静默截断。三层思考链支持（策略门控 → 原生 `thinking_delta` → 代理隧道 `<<think>>` 标签兜底，含孤儿闭标签恢复）。
- **单 seam 多供应商**——一个 `LLMProtocol` 接口统一 Anthropic 原生与 OpenAI 兼容端点（DeepSeek 等），共享重试/思考/工具调用语义，含 suspended-start tool-id 调停与跨供应商停止原因归一。
- **三级记忆**——L0 身份 → L1 会话内滚动摘要 → L2 跨会话精炼 → L3 按需事实检索，各层注入点与注入纪律分离；L3 是*被动工具*靠 prompt 策略激活，不硬塞上下文。L3 不上向量为评测驱动决策（实测 FTS 59.1% > 向量 36.4%）。
- **零信任 IPC**——所有 `ipcMain.handle` 经 `withHandler` 包装返回判别联合 `IpcResult<T>`，未捕获异常永不达渲染层。JSON 原子写（临时文件 + rename）保护配置、vault、崩溃草稿防半写态。
- **崩溃恢复与自愈存储**——`.running` 哨兵 + debounce 草稿落盘 + 恢复对话框闭环崩溃恢复。SQLite 跑 WAL + `integrity_check` + 30min 周期备份 + 退出 `.bak` + 损坏自动恢复（拷贝前先 WAL checkpoint——防"假备份"的关键细节）。
- **默认沙箱**——`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`；preload 强制 CJS 产出（沙箱无 ESM loader）。LLM 密钥经 `safeStorage` 存 OS keychain，明文永不同行至渲染层。
- **混合向量知识库**——FTS5 BM25 + FlatIndex 向量经 RRF 融合，配 transformers.js v4 WASM-in-Node 配方（ONNX runtime 注入 + customCache + 手动 pooling），全平台通用免原生编译。
- **编排即数据**——内容生产管线以序列化 `Capability` 图交付而非代码，用户可在画布上重排六阶段工作流。GitHub 仓为后端的 Registry（无托管后端）提供浏览/导入/auto-PR/一键更新，本地修改非破坏性保留、依赖递归重映射。
- **i18n 与主题从骨架做**——多 namespace 语言包、zh-CN/en 保持同步；主进程错误带 i18n key 交渲染层翻译。品牌色派生走 OKLCH 感知色空间（非 RGB 位移），保玻璃态通透。

### 快速开始

```bash
npm install
npm run dev
```
