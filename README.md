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

### 快速开始

```bash
npm install
npm run dev
```
