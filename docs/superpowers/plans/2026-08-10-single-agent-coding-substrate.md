# One Agent 智能基座 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 系统性补齐 One 的 agent 智能基座——从"只比裸 SDK 多一层路由"升级到"能自主坚持、上下文不失真、会规划、回答得体"的可用 agent。不新增角色 agent，全部通过共享的工具层/提示词层/编排消息层受益。

**Architecture:** 四层递进：A 层系统提示词工程（所有 agent 共享行为指令，杠杆最大）→ B 层单 agent 工具基座（项目根 + 编码工具 + 并行 + token 感知）→ C 层编排路径消息保真（**cache 写入 tool 轨迹 Task 8a** + **条件化 assembleMessages Task 8b** + thinking Task 9，治多 agent 链路"失忆"）→ D 层规划能力（规划工具 + 纪律）。不碰 Pregel superstep 执行模型（铁律7）、五模式语义、HITL、L0-L3 记忆注入点——只在 agent executor 的 cache 写入、消息组装、工具循环、系统拼装四个点动刀。

**Tech Stack:** TypeScript / Node.js fs APIs / Zod / Vitest / better-sqlite3（migration v3）

## 用户感知的"不聪明" → 根因 → 任务映射

| 现象 | 代码根因 | 任务 |
|---|---|---|
| 不够自主坚持 | `agent.ts:85` 系统提示词无 autonomy 纪律；工具失败 `{ok:false}` 后模型常直接停 | Task 5（系统前缀 autonomy 段） |
| 回答质量/表达差 | 无 output style 规范；Codex 按改动大小分档，One 无 | Task 5（系统前缀 output style 段） |
| 上下文/记忆不行（单 agent） | L1 用消息条数（20条）非 token；cache 200 条硬截断 | Task 7（token 感知截断） |
| 上下文/记忆不行（多 agent） | **两层根因**：① `patterns/agent.ts:81-85` 跑完后只把 `finalText` 写 cache，tool 轨迹未入库；② `assembleMessages:100` 无条件剥 tool 块 + 字符串拼接 | Task 8a（cache 写入 tool 轨迹）+ Task 8b（条件化 assembleMessages） |
| 多 agent 剥块回归基线 | `stripToolBlocksFilter` 回归测试在 `constraints.test.ts:67-80`（**非** `sequential.test.ts`）；`repairToolPairs` 在 `constraints.test.ts:7` | Task 8b Step 3 跑 `npm test -- constraints` 而非 sequential |
| 推理过程不可见（编排模式） | `patterns/agent.ts:65` `onThinking: () => {}` 丢弃 thinking | Task 9（编排模式保留 thinking） |
| 理解/规划能力弱 | 无规划工具（Codex 有 `update_plan`）；无 planning 纪律 | Task 6（规划工具 + 纪律） |
| 工具有了够不到代码 | 无"项目根"概念；`file.ts` 围栏锁死笔记库；`shell_run` cwd 默认 homedir | Task 0（项目根） |
| 多步操作慢 | `agent.ts:152` 工具循环串行 | Task 4（并行执行） |
| shell 不够自主（Codex 差距残留） | `shell_run` 仍 `approvalMode='always'`，每步命令需人工审批；无沙箱 | **本方案不覆盖**（见 §已知边界）；后续单独立项 |
| 编辑器跑编排无项目上下文 | 项目选择器仅在 HomePage；Editor 页跑 orchestrate 时用户无法选 cwd | Task 0 Step 7b（Editor 页项目路径，与首页同模式） |

## Global Constraints

- **铁律6**：Agent 管 context，tool-use 循环借力 SDK——不改这个边界，只优化循环内调度。
- **铁律7**：Pregel superstep 执行模型不动——本方案只改 agent executor 的消息组装（`patterns/agent.ts`），不碰 runner 的 wavefront/BFS 执行。
- **铁律8**：`max_tokens` 从 `config.defaultOptions` 取，不动。
- **铁律11**：工具调用失败返回 `{ ok: false }` JSON 不抛异常——新增工具遵守此语义。
- **铁律16-18 精神（条件化，非一律保留）**：下游 **有 tools** 的 agent → 保留 tool_use/tool_result 配对 + `repairToolPairs`；下游 **无 tools** 的 agent → 继续 `stripToolBlocksFilter`（治 Anthropic 2013，回归测试在 `constraints.test.ts:67-80`，**非** sequential.test.ts）。Task 8b 按 `config.tools?.length` 分支（tools 可选字段，须 `?? 0`），不可无脑保留全部 tool 块。
- **系统前缀单点注入**：`buildSystemPrefix()` **只在** `agent.ts:85` 拼进 system——禁止同时在 `home.ts` 拼，否则首页主 Agent 经 `new Agent(config)` 会被双注入。
- **资产级 allowlist**：`allowedToolNames` 为空 = 全量工具（新工具自动可见）；已配置白名单的 agent/capability **不会**自动获得 `grep`/`glob`/`str_replace_editor`/`update_plan`——需在管理页补名单或文档说明（Task 1/2/3/6 注册后检查典型资产）。
- **路径围栏不破语义**：workspaceRoot 是"又一个合法根"，不是"取消围栏"。越界写入仍拒，危险 shell 仍拦。
- **i18n（T2）**：工具 description 可中文（给 LLM 看的指令）；错误 `messageKey` 走 `errors.tools.*`，UI 文案不硬编码中文。
- **异步 I/O（铁律23 精神）**：文件/搜索工具用 `fs/promises`。
- **TDD**：每个工具一个 `.test.ts`；`ONE_FILE_ROOTS` env 隔离真实文件系统。
- **DB 迁移**：沿用 `storage/db.ts` 既有 v1/v2 模式，加 v3。
- **commit**：每个 Task 一次 commit，`feat:` 风格。

## 已知边界与诚实预期

做完本方案后，One 在 **「已选项目目录 + 首页单聊 / 带工具的编排节点」** 场景应明显更接近 Codex，但 **不会完全等同**：

| 差距项 | 原因 | 本方案处理 |
|---|---|---|
| shell 每步审批 | `shell_run` 默认 always 审批，无 Codex 式沙箱默认可跑 | 不覆盖；后续可做单会话 trust / session 级 `access: write` |
| 大仓库搜索慢/不全 | grep/glob 纯 TS 遍历，`MAX_WALK=5000` 文件上限，无 bundled ripgrep | Task 2/3 写清边界；大 repo 可能截断，后续可 bundled rg |
| Home agent 指令竞争 | 前缀 + 路由 + 创建 + 记忆 + 编码纪律同挤一条 system | MVP 接受；长期可拆「编码模式」会话或减路由段权重 |
| Editor 无项目 UI | 仅 HomePage 有选择器时 Editor 编排缺 cwd | Task 0 Step 7b 补 Editor |
| 并行工具 UX | 多路 `shell_run` 同时弹审批 | Task 4 并行保留；审批仍串行展示（`executeTool` 内部） |

## File Structure

**新增文件：**
- `src/main/tools/builtin/strReplace.ts` + `.test.ts` — 行级编辑（view/str_replace/insert）
- `src/main/tools/builtin/grep.ts` + `.test.ts` — 代码树正则搜索
- `src/main/tools/builtin/glob.ts` + `.test.ts` — 文件名模式查找
- `src/main/tools/builtin/plan.ts` + `.test.ts` — 规划工具（update_plan）
- `src/main/tools/system-prefix.ts` + `.test.ts` — 框架级行为指令前缀
- `src/main/llm/token-count.ts` + `.test.ts` — 近似 token 计数
- `src/main/orchestrator/patterns/agent.test.ts` — assembleMessages + thinking 透传测试

**修改文件：**
- `src/main/tools/registry.ts:37` — ToolContext 加 `workspaceRoot?` + `planState?`
- `src/main/tools/builtin/file.ts` — 导出 `resolveConfined` 等；围栏接纳 workspaceRoot
- `src/main/tools/builtin/shell.ts:151` — cwd 默认值链入 workspaceRoot
- `src/main/orchestrator/agent.ts:85,152` — 系统前缀拼装 + 工具循环并行
- `src/main/orchestrator/patterns/agent.ts:52-85,96-126` — cache 写入 tool 轨迹 + 条件化 assembleMessages + thinking 透传
- `src/main/orchestrator/agent.ts` — `AgentRunCallbacks.onToolCall` 扩展传 `toolUseId`（Task 8a）
- `src/shared/types.ts` — `AgentRunCallbacks` 签名扩展（Task 8a）
- `src/main/ipc/home.ts:337,368,472,487` — toolCtx 注入 workspaceRoot（**不改** instructions 拼前缀）
- `src/main/ipc/orchestrate.ts:148,161` — toolCtx 注入 workspaceRoot
- `src/main/index.ts:138-140` — 注册新工具
- `src/main/storage/db.ts` — migration v3：sessions 加 cwd 列
- `src/main/storage/memory/l1.ts` — token 阈值触发
- `src/main/orchestrator/runner.ts:307` — cache token 感知截断
- `src/preload/index.ts` — 暴露 `sessions.getCwd`、`app.pickDirectory`（无 `setCwd`——cwd 经 `home.chat` 写入）
- `src/renderer/src/pages/HomePage.tsx` — 首页项目路径选择器（**非** SettingsPage——cwd 是会话属性）
- `src/renderer/src/pages/EditorPage.tsx` — 编辑器页项目路径选择器（Task 0 Step 7b，与 HomePage 同模式）

---

## Task 0: 项目根概念（workspaceRoot）

**Files:**
- Modify: `src/main/tools/registry.ts:37`（ToolContext）
- Modify: `src/main/orchestrator/agent.ts:47`（AgentDeps.toolCtx）
- Modify: `src/main/storage/db.ts`（migration v3）
- Modify: `src/main/tools/builtin/file.ts`（围栏接纳）
- Modify: `src/main/tools/builtin/shell.ts:151`（cwd 默认）
- Modify: `src/main/ipc/home.ts` + `src/main/ipc/orchestrate.ts`（toolCtx 注入）
- Modify: `src/preload/index.ts`（暴露 `sessions.getCwd`、`app.pickDirectory`）
- Modify: `src/renderer/src/pages/HomePage.tsx`（首页项目路径选择器）
- Modify: `src/renderer/src/pages/EditorPage.tsx`（编辑器页项目路径，Step 7b）
- Test: `src/main/tools/builtin/plan.test.ts` 顺带测 workspaceRoot 流转

**Interfaces:**
- Produces: `ToolContext.workspaceRoot?: string` — 所有工具经此拿当前项目根；DB `sessions.cwd` 列持久化；IPC `sessions:getCwd`（只读）；cwd **写入**仅经 `home.chat({ projectPath })` 或 orchestrate 等价入参

**设计要点**：One 完全没有"项目"概念。最小侵入：sessions 表加 cwd 列（migration v3，沿用 v1/v2 模式），ToolContext 加 workspaceRoot 字段（单一咽喉），file.ts 围栏接纳 workspaceRoot 为合法根（不破围栏语义），shell_run 默认 cwd 链入 workspaceRoot。

- [ ] **Step 1: migration v3 — sessions 加 cwd 列**

读 `src/main/storage/db.ts`，找到 v2 迁移块，在其后加 v3：

```ts
// v3: sessions 加 cwd 列（项目根概念，agent 文件工具 + shell 默认 cwd 用）
// 沿用 v1/v2 模式：MIGRATIONS 类型是 Array<{ version: number; sql: string }>，
// runMigrations 调 db.exec(m.sql)——不可用 up: (db) => {} 回调格式（类型不匹配）。
{
  version: 3,
  sql: 'ALTER TABLE sessions ADD COLUMN cwd TEXT',
},
```

- [ ] **Step 2: ToolContext 加 workspaceRoot**

`src/main/tools/registry.ts:37`：

```ts
export interface ToolContext {
  sessionId?: string
  /** 当前项目根绝对路径——文件工具扩展围栏、shell 默认 cwd 用。无 = 无项目上下文 */
  workspaceRoot?: string
  signal?: AbortSignal
  onPropose?: (draft: import('@shared/types').CreateDraft) => void
  onAskUser?: (req: { question: string; context?: string }) => Promise<string>
  onApprove?: (req: { toolName: string; args: unknown }) => Promise<{ approved: boolean; reason?: string }>
}
```

`src/main/orchestrator/agent.ts:47` 的 `AgentDeps.toolCtx` 同步加 `workspaceRoot?: string`。

- [ ] **Step 3: file.ts 围栏接纳 workspaceRoot**

`src/main/tools/builtin/file.ts`：

(a) 导出 `resolveConfined`、`notAllowedPayload`、`errPayload`、`writeFileAtomic`（改 `function` → `export function`）。

(b) `getFileRoots` 加可选 workspaceRoot 参数：

```ts
// ⚠️ 不能简单 unshift 到 base 数组——现有代码在 ONE_FILE_ROOTS env 有效时
// 会 early return（file.ts:52），workspaceRoot 永远加不上。须把 workspaceRoot
// 放在 env 判断之前 push，env 路径也 push 而非替换返回。
export function getFileRoots(workspaceRoot?: string): string[] {
  const roots: string[] = []
  if (workspaceRoot) roots.push(resolve(workspaceRoot))  // 项目根优先
  const envRaw = process.env.ONE_FILE_ROOTS
  if (envRaw) {
    try {
      const parsed: unknown = JSON.parse(envRaw)
      if (Array.isArray(parsed)) {
        roots.push(...parsed.filter((r): r is string => typeof r === 'string')
          .map((r) => resolve(expandHome(r))))
        return roots  // env 有效：返回 workspaceRoot + env roots
      }
    } catch {
      // env 解析失败按无覆盖处理
    }
  }
  roots.push(resolve(DEFAULT_VAULT), resolve(join(getUserDataDir(), 'exports')))
  // ... config 扩展根逻辑不变（push 到 roots）
  return roots
}
```

(c) `resolveConfined(rawPath, workspaceRoot?)` 第二参数透传。

(d) 三个工具 handler `async (args) =>` 改 `async (args, ctx) =>`，调 `resolveConfined(path, ctx?.workspaceRoot)`。

- [ ] **Step 4: shell.ts cwd 默认链入 workspaceRoot**

`src/main/tools/builtin/shell.ts:151`：

```ts
const workDir = cwd ?? ctx.workspaceRoot ?? homedir()
```
handler 签名已是 `async (args, ctx)`，直接用 `ctx.workspaceRoot`。

- [ ] **Step 5: Session 类型 + home.chat 入参加 projectPath**

设计决策：**projectPath 走 `home.chat` 入参传到主进程，主进程为真相源**。不依赖渲染层独立维护 cwd 状态——会话切换时主进程按 sessionId 查 DB 重新注入，渲染层只管显示和选择。

`src/shared/types.ts:720` 的 `Session` 接口加字段：

```ts
export interface Session {
  id: string
  userId: string
  title: string
  capabilityId?: string
  cwd?: string          // ← 新增：项目根绝对路径
  createdAt: number
  updatedAt: number
}
```

`src/preload/index.ts:99-104` 的 `home.chat` 入参类型加 `projectPath?`：

```ts
chat: (input: {
  message: string
  sessionId?: string
  /** 项目根路径（写入 sessions.cwd，agent 文件工具 + shell 默认 cwd 用） */
  projectPath?: string
  mentions?: Array<{ kind: 'agent' | 'capability' | 'skill'; id: string }>
}) => Promise<IpcResult<{ runId: string }>>
```

`src/preload/index.ts:78-86` 的 `sessions` 命名空间加 getCwd（供渲染层读当前会话项目根显示用）：

```ts
sessions: {
  // ... 既有方法
  getCwd: (sessionId: string) => ipcRenderer.invoke('sessions:getCwd', sessionId)
}
```

对应 impl 区（line 222-230）加：
```ts
getCwd: (sessionId) => ipcRenderer.invoke('sessions:getCwd', sessionId),
```

- [ ] **Step 6: 主进程 — home.chat 收 projectPath + toolCtx 注入 workspaceRoot**

`src/main/ipc/home.ts`：

(a) `home:chat` handler 接收 `projectPath`，持久化到 sessions.cwd（会话已存在则 UPDATE，新建则在创建时带 cwd）：

```ts
// home:chat handler 开头，解构入参时加 projectPath
const { message, sessionId, projectPath, mentions } = input

// 若传了 projectPath，持久化（新建会话时 createSession 带 cwd；已存在则 UPDATE）
if (projectPath) {
  if (sessionId) {
    // 已存在会话：更新 cwd
    getDb().prepare('UPDATE sessions SET cwd = ?, updated_at = ? WHERE id = ?')
      .run(projectPath, Date.now(), sessionId)
  }
  // 新建会话的场景：home.chat 内部 createSession 时带 cwd（见 sessions:create 改造）
}
```

> 注：读 home.ts 找到 `createSession` 调用点，让它接受 cwd 参数并写入 INSERT。若 sessions:create 是另一个 IPC handler，同步加 cwd 入参。

(b) `home.ts:337-344` 的 `AgentConfig` 构造前，从 DB 查 cwd 注入 toolCtx。主 agent toolCtx（约 home.ts:368）：

```ts
// 查当前会话的 cwd（主进程为真相源，渲染层不传也行）
const workspaceRoot = sessionId
  ? (getDb().prepare('SELECT cwd FROM sessions WHERE id = ?').get(sessionId) as { cwd?: string } | undefined)?.cwd
  : undefined

const toolCtx = {
  sessionId: sid,
  workspaceRoot,                    // ← 新增
  signal,
  onPropose, onAskUser, onApprove,
}
```

(c) team-graph node toolCtx（home.ts:487）+ `src/main/ipc/orchestrate.ts:161` 同样从 session 查 cwd 注入。

(d) 新增 IPC `sessions:getCwd`（铁律2：preload + ipcMain.handle 成对，经 withHandler 包装）：

```ts
withHandler('sessions:getCwd', async (_e, sessionId: string) => {
  const row = getDb().prepare('SELECT cwd FROM sessions WHERE id = ?').get(sessionId) as { cwd?: string } | undefined
  return row?.cwd ?? null
})
```

> 注：不需要单独的 `sessions:setCwd`——projectPath 经 `home.chat` 入参写入，主进程单一入口，避免渲染层直写 DB 绕过 chat 流程。

- [ ] **Step 7: 首页加项目路径选择器（chat-shell 顶部）**

探子已确认插入点：`src/renderer/src/pages/HomePage.tsx:368` 是 `<div className="chat-shell">`，第一个子元素在 369 行。项目选择器作为 chat-shell 第一个子元素插入。

(a) HomePage.tsx 顶部加本地状态 + 加载当前会话 cwd：

```tsx
// HomePage 组件内（约 line 77 附近，已有 const sessionId = useChatStore(...)）
const [projectPath, setProjectPath] = useState<string>('')
const [recentPaths, setRecentPaths] = useState<string[]>([])

// 会话切换时从主进程读 cwd（主进程为真相源）
useEffect(() => {
  if (sessionId) {
    window.one.sessions.getCwd(sessionId).then(unwrap).then((cwd) => {
      setProjectPath(cwd ?? '')
    })
  } else {
    setProjectPath('')
  }
}, [sessionId])

// 最近用过的项目路径（从 sessions list 提取 cwd 去重）
useEffect(() => {
  window.one.sessions.list().then(unwrap).then((sessions) => {
    const paths = Array.from(new Set(
      sessions.map((s) => s.cwd).filter((p): p is string => !!p)
    ))
    setRecentPaths(paths)
  })
}, [])
```

(b) 目录选择器——用 Electron `dialog.showOpenDialog`（仿 `theme.pickBackground` 模式）。需新 IPC `app:pickDirectory`（preload `app` 命名空间加 `pickDirectory`）：

主进程侧加：
```ts
withHandler('app:pickDirectory', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  return result.canceled ? null : result.filePaths[0]
})
```
preload `app` 命名空间加：
```ts
pickDirectory: () => ipcRenderer.invoke('app:pickDirectory')
```

(c) 在 `HomePage.tsx:368` 的 `<div className="chat-shell">` 内、369 行之前插入 header：

```tsx
<div className="chat-shell">
  {/* 项目路径选择器 — chat 顶部 */}
  <div className="chat-header">
    <select
      value={projectPath}
      onChange={(e) => {
        const v = e.target.value
        if (v === '__pick__') {
          window.one.app.pickDirectory().then(unwrap).then((p) => {
            if (p) setProjectPath(p)
          })
        } else {
          setProjectPath(v)
        }
      }}
      style={selectStyle}
    >
      <option value="">无项目上下文（默认 home）</option>
      {recentPaths.map((p) => (
        <option key={p} value={p}>{p}</option>
      ))}
      <option value="__pick__">+ 选择目录…</option>
    </select>
  </div>
  {/* 原有 pending-create bar（line 369 起） */}
```

`selectStyle` 常量放 HomePage 组件外（仿 ListPage.tsx:443）：

```tsx
const selectStyle: React.CSSProperties = {
  height: 36,
  borderRadius: 12,
  border: '1px solid var(--color-border)',
  background: 'var(--color-bg-1)',
  color: 'var(--color-fg-1)',
  padding: '0 10px',
  fontSize: 13,
  maxWidth: 400,
}
```

(d) `onSend` 调用（HomePage.tsx:322-329）传 projectPath：

```tsx
const result = await window.one.home.chat({
  message: text,
  sessionId: sessionId ?? undefined,
  projectPath: projectPath || undefined,   // ← 新增
  mentions: chipMentions.length > 0 ? chipMentions : undefined,
}).then(unwrap)
```

(e) `src/renderer/src/styles/app.css` 在 `.chat-shell`（约 line 252）附近加 `.chat-header`：

```css
.chat-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 4px;
}
```

> UI 说明：项目选择器是首页聊天顶部的原生 `<select>`（无项目/最近列表/选择目录三项）。选定后通过 `home.chat` 的 projectPath 入参传到主进程写入 sessions.cwd，下次该会话加载时主进程回读。**设置页不改**——项目路径是会话属性，不是全局设置。

- [ ] **Step 7b: EditorPage 同步项目路径选择器**

编辑器跑编排（`orchestrate.ts`）同样需要 `workspaceRoot`，否则 grep/glob/shell 在 Editor 链路仍够不到代码。

(a) 读 `src/renderer/src/pages/EditorPage.tsx`，找到聊天/运行入口的 shell 容器，插入与 HomePage Step 7(c) **同结构**的 `<select>` + `projectPath` 状态。

(b) 会话切换时 `window.one.sessions.getCwd(sessionId)` 回读；`onRun` / 触发 orchestrate 的 IPC 调用传 `projectPath`（若 orchestrate handler 尚无入参，同步加 `projectPath?` 并 UPDATE sessions.cwd，逻辑 mirror home.chat Step 6(a)）。

(c) orchestrate IPC preload 类型 + handler 与 home 对齐：`toolCtx.workspaceRoot` 从 sessionId 查 DB。

(d) i18n：选择器 placeholder 走 `home.projectPath.*` 或新建 `editor.projectPath.*` key，禁止 JSX 硬编码中文。

- [ ] **Step 8: typecheck + 回归 + commit**

```bash
npm run typecheck && npm test
git add -A
git commit -m "feat: 项目根概念（workspaceRoot 进 ToolContext + sessions.cwd + 首页项目选择器）
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 1: str_replace_editor 工具（行级编辑）

**Files:**
- Create: `src/main/tools/builtin/strReplace.ts`
- Test: `src/main/tools/builtin/strReplace.test.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `resolveConfined` / `notAllowedPayload` / `errPayload` / `writeFileAtomic` from `./file.ts`（Task 0 已导出）；`registerTool`
- Produces: `registerStrReplaceTools()`；工具名 `str_replace_editor`，命令 `view` / `str_replace` / `insert`

**设计要点**：对齐 Claude Code 三命令语义。`str_replace` 的 `old_str` 必须唯一匹配，不唯一报错逼 LLM 加上下文。改一行只发一个 diff，不整文件覆写。

- [ ] **Step 1: 写失败测试 `strReplace.test.ts`**

```ts
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { clearTools, executeTool, listToolDefs } from '../registry'
import { registerStrReplaceTools } from './strReplace'

vi.mock('../../storage/paths', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const p = await import('node:path')
  const root = mkdtempSync(p.join(tmpdir(), 'one-strrep-test-'))
  ;(globalThis as Record<string, unknown>).__oneStrrepRoot = root
  return { getUserDataDir: () => root }
})

const tmpRoot = (): string => (globalThis as Record<string, unknown>).__oneStrrepRoot as string
const vault = (): string => path.join(tmpRoot(), 'vault')

describe('tools/builtin/strReplace', () => {
  beforeEach(() => {
    clearTools()
    registerStrReplaceTools()
    process.env.ONE_FILE_ROOTS = JSON.stringify([vault()])
    mkdirSync(vault(), { recursive: true })
  })
  afterEach(() => { delete process.env.ONE_FILE_ROOTS })

  it('注册 str_replace_editor', () => {
    expect(listToolDefs().map((t) => t.name)).toContain('str_replace_editor')
  })

  it('view 按行范围读', async () => {
    const f = path.join(vault(), 'a.ts')
    writeFileSync(f, 'line1\nline2\nline3\nline4\nline5\n')
    const r = await executeTool('str_replace_editor', {
      command: 'view', path: f, view_range: { start: 2, end: 4 },
    }, 'tu_1', {})
    const d = JSON.parse(r.content)
    expect(d.ok).toBe(true)
    expect(d.content).toBe('line2\nline3\nline4\n')
    expect(d.startLine).toBe(2)
  })

  it('str_replace 精确替换', async () => {
    const f = path.join(vault(), 'b.ts')
    writeFileSync(f, 'const x = 1\nconst y = 2\n')
    const r = await executeTool('str_replace_editor', {
      command: 'str_replace', path: f,
      old_str: 'const x = 1', new_str: 'const x = 42',
    }, 'tu_2', {})
    const d = JSON.parse(r.content)
    expect(d.ok).toBe(true)
    expect(readFileSync(f, 'utf8')).toBe('const x = 42\nconst y = 2\n')
  })

  it('old_str 不唯一时报错', async () => {
    const f = path.join(vault(), 'c.ts')
    writeFileSync(f, 'dup\ndup\n')
    const r = await executeTool('str_replace_editor', {
      command: 'str_replace', path: f, old_str: 'dup', new_str: 'uniq',
    }, 'tu_3', {})
    const d = JSON.parse(r.content)
    expect(d.ok).toBe(false)
    expect(d.error).toBe('old_str_not_unique')
  })

  it('old_str 不存在时报错', async () => {
    const f = path.join(vault(), 'd.ts')
    writeFileSync(f, 'hello\n')
    const r = await executeTool('str_replace_editor', {
      command: 'str_replace', path: f, old_str: 'nope', new_str: 'yes',
    }, 'tu_4', {})
    expect(JSON.parse(r.content).error).toBe('old_str_not_found')
  })

  it('insert 行后插入', async () => {
    const f = path.join(vault(), 'e.ts')
    writeFileSync(f, 'a\nb\n')
    const r = await executeTool('str_replace_editor', {
      command: 'insert', path: f, insert_line: 1, new_str: 'inserted\n',
    }, 'tu_5', {})
    expect(JSON.parse(r.content).ok).toBe(true)
    expect(readFileSync(f, 'utf8')).toBe('a\ninserted\nb\n')
  })

  it('workspaceRoot 内路径放行', async () => {
    const proj = path.join(tmpRoot(), 'myproject')
    mkdirSync(proj, { recursive: true })
    const f = path.join(proj, 'x.ts')
    writeFileSync(f, 'orig\n')
    const r = await executeTool('str_replace_editor', {
      command: 'str_replace', path: f, old_str: 'orig', new_str: 'new',
    }, 'tu_6', { workspaceRoot: proj })
    expect(JSON.parse(r.content).ok).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- strReplace`
Expected: FAIL — `registerStrReplaceTools is not a function`

- [ ] **Step 3: 实现 `strReplace.ts`**

```ts
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { registerTool } from '../registry'
import { resolveConfined, notAllowedPayload, errPayload, writeFileAtomic } from './file'

const ViewRangeSchema = z.object({
  start: z.number().int().min(1),
  end: z.number().int().min(1).optional(),
}).optional()

const EditorSchema = z.object({
  command: z.enum(['view', 'str_replace', 'insert']),
  path: z.string().min(1),
  view_range: ViewRangeSchema.optional(),
  old_str: z.string().optional(),
  new_str: z.string().optional(),
  insert_line: z.number().int().min(0).optional(),
})

export function registerStrReplaceTools(): void {
  registerTool(
    'str_replace_editor',
    '对文件的行级编辑工具。三命令：view（按 view_range 读行，不传读全文件截断）、'
    + 'str_replace（用 new_str 精确替换 old_str，old_str 必须唯一匹配，不唯一则加更多上下文行重试）、'
    + 'insert（在 insert_line 行号后插入 new_str，0=文件开头）。改一行只用 str_replace，不要重写整个文件。'
    + '路径限允许根目录内（含当前项目根）。',
    EditorSchema,
    async (args, ctx) => {
      const input = args as z.infer<typeof EditorSchema>
      const abs = resolveConfined(input.path, ctx?.workspaceRoot)
      if (!abs) return notAllowedPayload(input.path)

      if (input.command === 'view') {
        try {
          if (!existsSync(abs)) return { ok: false, error: 'not_found' }
          const text = await readFile(abs, 'utf-8')
          const lines = text.split('\n')
          const start = input.view_range?.start ?? 1
          const end = input.view_range?.end ?? lines.length
          const slice = lines.slice(start - 1, end).join('\n')
          return { ok: true, path: abs, content: slice + '\n', startLine: start }
        } catch (e) { return errPayload(e) }
      }

      if (input.command === 'str_replace') {
        if (input.old_str === undefined || input.new_str === undefined) {
          return { ok: false, error: 'missing_old_or_new_str' }
        }
        try {
          if (!existsSync(abs)) return { ok: false, error: 'not_found' }
          const text = await readFile(abs, 'utf-8')
          const idx = text.indexOf(input.old_str)
          if (idx === -1) return { ok: false, error: 'old_str_not_found' }
          if (text.indexOf(input.old_str, idx + 1) !== -1) return { ok: false, error: 'old_str_not_unique' }
          const updated = text.slice(0, idx) + input.new_str + text.slice(idx + input.old_str.length)
          await writeFileAtomic(abs, updated)
          return { ok: true, path: abs }
        } catch (e) { return errPayload(e) }
      }

      if (input.command === 'insert') {
        if (input.new_str === undefined || input.insert_line === undefined) {
          return { ok: false, error: 'missing_insert_line_or_new_str' }
        }
        try {
          let text = ''
          if (existsSync(abs)) text = await readFile(abs, 'utf-8')
          const lines = text.split('\n')
          const at = Math.min(input.insert_line, lines.length)
          lines.splice(at, 0, ...input.new_str.split('\n'))
          await writeFileAtomic(abs, lines.join('\n'))
          return { ok: true, path: abs }
        } catch (e) { return errPayload(e) }
      }
      return { ok: false, error: 'unknown_command' }
    },
    'auto',
  )
}
```

- [ ] **Step 4: 运行测试通过**

Run: `npm test -- strReplace`
Expected: PASS

- [ ] **Step 5: 注册 + typecheck + commit**

`src/main/index.ts` 加 `import { registerStrReplaceTools } from './tools/builtin/strReplace'`，在 `registerFileTools()` 后加 `registerStrReplaceTools()`。

> **allowlist**：已设 `allowedToolNames` 的资产须手动加入 `str_replace_editor`（见 Global Constraints）。

```bash
npm run typecheck
git add src/main/tools/builtin/strReplace.ts src/main/tools/builtin/strReplace.test.ts src/main/tools/builtin/file.ts src/main/index.ts
git commit -m "feat: str_replace_editor 行级编辑工具（view/str_replace/insert）
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: grep 工具（代码树正则搜索）

**Files:**
- Create: `src/main/tools/builtin/grep.ts`
- Test: `src/main/tools/builtin/grep.test.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `getFileRoots` from `./file.ts`；`registerTool`
- Produces: `registerGrepTool()`；工具名 `grep`，参数 `{ pattern, path?, glob?, maxResults? }`

**设计要点**：纯 TS ripgrep 语义子集，无外部二进制（Electron 跨平台分发不带 ripgrep）。`getFileRoots(ctx?.workspaceRoot)` 让项目根被扫到。

**性能边界（MVP 接受，须在 description 中暗示）**：
- 单目录 walk 上限 `MAX_WALK=5000` 文件，超限停止并返回 `truncated: true`
- 大 monorepo（>5k 源文件）可能漏命中——LLM 应缩小 `path` / `glob` 范围
- 后续迭代可 bundled `@vscode/ripgrep` 或 spawn 系统 `rg`（本方案不做）

- [ ] **Step 1: 写失败测试 `grep.test.ts`**

```ts
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { clearTools, executeTool, listToolDefs } from '../registry'
import { registerGrepTool } from './grep'

vi.mock('../../storage/paths', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const p = await import('node:path')
  const root = mkdtempSync(p.join(tmpdir(), 'one-grep-test-'))
  ;(globalThis as Record<string, unknown>).__oneGrepRoot = root
  return { getUserDataDir: () => root }
})

const tmpRoot = (): string => (globalThis as Record<string, unknown>).__oneGrepRoot as string
const vault = (): string => path.join(tmpRoot(), 'vault')

describe('tools/builtin/grep', () => {
  beforeEach(() => {
    clearTools()
    registerGrepTool()
    process.env.ONE_FILE_ROOTS = JSON.stringify([vault()])
    mkdirSync(vault(), { recursive: true })
  })
  afterEach(() => { delete process.env.ONE_FILE_ROOTS })

  it('注册 grep', () => {
    expect(listToolDefs().map((t) => t.name)).toContain('grep')
  })

  it('正则匹配返回行号与片段', async () => {
    writeFileSync(path.join(vault(), 'a.ts'), 'const foo = 1\nconst bar = foo + 2\n')
    const r = await executeTool('grep', { pattern: 'foo' }, 'tu_1', { workspaceRoot: vault() })
    const d = JSON.parse(r.content)
    expect(d.ok).toBe(true)
    expect(d.files[0].matches.length).toBe(2)
    expect(d.files[0].matches[0].line).toBe(1)
  })

  it('glob 过滤文件名', async () => {
    writeFileSync(path.join(vault(), 'a.ts'), 'target\n')
    writeFileSync(path.join(vault(), 'b.md'), 'target\n')
    const r = await executeTool('grep', { pattern: 'target', glob: '*.ts' }, 'tu_2', { workspaceRoot: vault() })
    expect(JSON.parse(r.content).files.length).toBe(1)
  })

  it('跳过 node_modules', async () => {
    mkdirSync(path.join(vault(), 'node_modules'), { recursive: true })
    writeFileSync(path.join(vault(), 'node_modules', 'dep.ts'), 'secret\n')
    writeFileSync(path.join(vault(), 'main.ts'), 'secret\n')
    const r = await executeTool('grep', { pattern: 'secret' }, 'tu_3', { workspaceRoot: vault() })
    const d = JSON.parse(r.content)
    expect(d.files.length).toBe(1)
    expect(d.files[0].path).not.toContain('node_modules')
  })

  it('workspaceRoot 内可搜', async () => {
    const proj = path.join(tmpRoot(), 'proj')
    mkdirSync(proj, { recursive: true })
    writeFileSync(path.join(proj, 's.ts'), 'found\n')
    const r = await executeTool('grep', { pattern: 'found' }, 'tu_4', { workspaceRoot: proj })
    expect(JSON.parse(r.content).files.length).toBe(1)
  })

  it('未设 workspaceRoot 时返回 no_workspace 提示', async () => {
    const r = await executeTool('grep', { pattern: 'foo' }, 'tu_5', {})  // 无 workspaceRoot
    const d = JSON.parse(r.content)
    expect(d.ok).toBe(false)
    expect(d.error).toBe('no_workspace')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- grep`
Expected: FAIL

- [ ] **Step 3: 实现 `grep.ts`**

```ts
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { registerTool } from '../registry'
import { getFileRoots } from './file'

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', '.next'])
const MAX_WALK = 5000
const SNIPPET_LEN = 200

const GrepSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  maxResults: z.number().int().min(1).max(200).default(30),
})

function globToRe(pattern: string): RegExp {
  return new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
}

async function walkGrep(
  absDir: string, re: RegExp, globRe: RegExp | null, max: number,
  files: Array<{ path: string; matches: Array<{ line: number; snippet: string }> }>, walked: { n: number },
): Promise<void> {
  if (files.length >= max || walked.n > MAX_WALK) return
  let entries
  try { entries = await readdir(absDir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (files.length >= max || walked.n > MAX_WALK) return
    const full = join(absDir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
      await walkGrep(full, re, globRe, max, files, walked)
    } else {
      walked.n++
      if (globRe && !globRe.test(e.name)) continue
      let text: string
      try { text = await readFile(full, 'utf-8') } catch { continue }
      const lines = text.split('\n')
      const matches: Array<{ line: number; snippet: string }> = []
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matches.push({ line: i + 1, snippet: lines[i].trim().slice(0, SNIPPET_LEN) })
          if (matches.length >= 10) break
        }
      }
      if (matches.length) files.push({ path: full, matches })
    }
  }
}

export function registerGrepTool(): void {
  registerTool(
    'grep',
    '在允许的根目录内正则搜索文件内容（ripgrep 语义子集，纯 TS 无外部依赖）。'
    + '跳过 .git/node_modules/dist。返回命中文件 + 行号 + 片段。'
    + '搜索代码定义/引用用这个，不要用 file_search（那个只扫笔记）。'
    + 'pattern 是正则；glob 过滤文件名（如 "*.ts"）；path 限定起始子目录。',
    GrepSchema,
    async (args, ctx) => {
      const input = args as z.infer<typeof GrepSchema>
      // 没设项目根时显式提示（不静默回退笔记库——那会让"搜代码"指令和能力脱节）
      if (!ctx?.workspaceRoot) {
        return { ok: false, error: 'no_workspace', hint: '当前会话未设置项目路径，请在当前页面顶部选择项目目录后再搜代码（首页/编辑器页均有选择器）。' }
      }
      let re: RegExp
      try { re = new RegExp(input.pattern) } catch (e) {
        return { ok: false, error: 'invalid_regex', hint: (e as Error).message }
      }
      const globRe = input.glob ? globToRe(input.glob) : null
      const files: Array<{ path: string; matches: Array<{ line: number; snippet: string }> }> = []
      const walked = { n: 0 }
      for (const root of getFileRoots(ctx?.workspaceRoot)) {
        if (files.length >= input.maxResults) break
        const start = input.path ? join(root, input.path) : root
        await walkGrep(start, re, globRe, input.maxResults, files, walked)
      }
      return { ok: true, files, totalMatches: files.reduce((n, f) => n + f.matches.length, 0), truncated: walked.n > MAX_WALK }
    },
    'auto',
  )
}
```

> 返回体加 `truncated?: boolean`，walk 触顶时为 true，便于 LLM 收窄搜索范围。

- [ ] **Step 4: 测试通过 + 注册 + typecheck + commit**

```bash
npm test -- grep
```
`src/main/index.ts` 加 import + `registerGrepTool()`。

> **allowlist**：已设白名单的资产须手动加入 `grep`。

```bash
npm run typecheck
git add src/main/tools/builtin/grep.ts src/main/tools/builtin/grep.test.ts src/main/index.ts
git commit -m "feat: grep 代码树正则搜索工具（ripgrep 语义子集）
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: glob 工具（文件名模式查找）

**Files:**
- Create: `src/main/tools/builtin/glob.ts`
- Test: `src/main/tools/builtin/glob.test.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `getFileRoots`；`registerTool`
- Produces: `registerGlobTool()`；工具名 `glob`，参数 `{ pattern, path?, maxResults? }`

**设计要点**：按文件名模式查找。**实现注意**：`walkGlob` 必须用 **相对项目根的路径**（`path.relative(root, full).replace(/\\/g, '/')`）做 pattern 匹配，不能只测 `e.name`——否则 `**/src/**/*.ts` 类 pattern 会误匹配。MVP description 可写「pattern 匹配相对路径；简单场景用 `*.ts`」。

- [ ] **Step 1: 写失败测试 `glob.test.ts`**

```ts
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { clearTools, executeTool, listToolDefs } from '../registry'
import { registerGlobTool } from './glob'

vi.mock('../../storage/paths', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const p = await import('node:path')
  const root = mkdtempSync(p.join(tmpdir(), 'one-glob-test-'))
  ;(globalThis as Record<string, unknown>).__oneGlobRoot = root
  return { getUserDataDir: () => root }
})

const tmpRoot = (): string => (globalThis as Record<string, unknown>).__oneGlobRoot as string
const vault = (): string => path.join(tmpRoot(), 'vault')

describe('tools/builtin/glob', () => {
  beforeEach(() => {
    clearTools()
    registerGlobTool()
    process.env.ONE_FILE_ROOTS = JSON.stringify([vault()])
    mkdirSync(vault(), { recursive: true })
  })
  afterEach(() => { delete process.env.ONE_FILE_ROOTS })

  it('注册 glob', () => {
    expect(listToolDefs().map((t) => t.name)).toContain('glob')
  })

  it('按扩展名模式查找', async () => {
    writeFileSync(path.join(vault(), 'a.ts'), '')
    writeFileSync(path.join(vault(), 'b.md'), '')
    mkdirSync(path.join(vault(), 'sub'), { recursive: true })
    writeFileSync(path.join(vault(), 'sub', 'c.ts'), '')
    const r = await executeTool('glob', { pattern: '**/*.ts' }, 'tu_1', { workspaceRoot: vault() })
    const d = JSON.parse(r.content)
    expect(d.ok).toBe(true)
    expect(d.files.length).toBe(2)
  })

  it('跳过 node_modules', async () => {
    mkdirSync(path.join(vault(), 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(path.join(vault(), 'node_modules', 'pkg', 'index.js'), '')
    writeFileSync(path.join(vault(), 'main.js'), '')
    const r = await executeTool('glob', { pattern: '**/*.js' }, 'tu_2', { workspaceRoot: vault() })
    expect(JSON.parse(r.content).files.length).toBe(1)
  })

  it('workspaceRoot 内可查', async () => {
    const proj = path.join(tmpRoot(), 'proj')
    mkdirSync(path.join(proj, 'sub'), { recursive: true })
    writeFileSync(path.join(proj, 'sub', 'x.ts'), '')
    const r = await executeTool('glob', { pattern: 'sub/*.ts' }, 'tu_3', { workspaceRoot: proj })
    expect(JSON.parse(r.content).files.length).toBe(1)
  })

  it('相对路径 pattern 匹配子目录', async () => {
    const proj = path.join(tmpRoot(), 'proj2')
    mkdirSync(path.join(proj, 'src', 'lib'), { recursive: true })
    writeFileSync(path.join(proj, 'src', 'lib', 'util.ts'), '')
    const r = await executeTool('glob', { pattern: 'src/lib/*.ts' }, 'tu_5', { workspaceRoot: proj })
    expect(JSON.parse(r.content).files.length).toBe(1)
  })

  it('未设 workspaceRoot 时返回 no_workspace 提示', async () => {
    const r = await executeTool('glob', { pattern: '**/*.ts' }, 'tu_4', {})  // 无 workspaceRoot
    const d = JSON.parse(r.content)
    expect(d.ok).toBe(false)
    expect(d.error).toBe('no_workspace')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- glob`
Expected: FAIL

- [ ] **Step 3: 实现 `glob.ts`**

```ts
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { registerTool } from '../registry'
import { getFileRoots } from './file'

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', '.next'])
const MAX_WALK = 5000

const GlobSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  maxResults: z.number().int().min(1).max(500).default(100),
})

function globToRe(pattern: string): RegExp {
  let re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  re = re.replace(/\*\*/g, '\x00')
  re = re.replace(/\*/g, '[^/]*')
  re = re.replace(/\x00/g, '.*')
  return new RegExp('^' + re + '$')
}

async function walkGlob(
  absDir: string,
  rootDir: string,
  re: RegExp,
  max: number,
  files: string[],
  walked: { n: number },
): Promise<void> {
  if (files.length >= max || walked.n > MAX_WALK) return
  let entries
  try { entries = await readdir(absDir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (files.length >= max || walked.n > MAX_WALK) return
    const full = join(absDir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
      await walkGlob(full, rootDir, re, max, files, walked)
    } else {
      walked.n++
      // 用相对 rootDir 的路径匹配 pattern（支持 **/src/**/*.ts）
      const rel = full.slice(rootDir.length + 1).replace(/\\/g, '/')
      if (re.test(rel)) files.push(full)
    }
  }
}

export function registerGlobTool(): void {
  registerTool(
    'glob',
    '按文件名模式查找文件路径（** 跨目录递归，* 单层）。跳过 .git/node_modules。'
    + '查找"有哪些 .ts 文件"用这个，不要用 file_search。返回绝对路径列表。',
    GlobSchema,
    async (args, ctx) => {
      const input = args as z.infer<typeof GlobSchema>
      if (!ctx?.workspaceRoot) {
        return { ok: false, error: 'no_workspace', hint: '当前会话未设置项目路径，请在当前页面顶部选择项目目录后再查找代码文件（首页/编辑器页均有选择器）。' }
      }
      const re = globToRe(input.pattern)
      const files: string[] = []
      const walked = { n: 0 }
      for (const root of getFileRoots(ctx?.workspaceRoot)) {
        if (files.length >= input.maxResults) break
        const start = input.path ? join(root, input.path) : root
        await walkGlob(start, root, re, input.maxResults, files, walked)
      }
      return { ok: true, files, truncated: walked.n > MAX_WALK }
    },
    'auto',
  )
}
```

- [ ] **Step 4: 测试通过 + 注册 + typecheck + commit**

```bash
npm test -- glob
npm run typecheck
git add src/main/tools/builtin/glob.ts src/main/tools/builtin/glob.test.ts src/main/index.ts
```

> **allowlist**：已设白名单的资产须手动加入 `glob`。

```bash
git commit -m "feat: glob 文件名模式查找工具
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 工具循环并行执行

**Files:**
- Modify: `src/main/orchestrator/agent.ts:150-194`（工具循环）
- Test: `src/main/orchestrator/agent.test.ts`（新建）

**Interfaces:**
- Consumes: `executeTool`
- Produces: 独立 tool_use 并发执行，结果按原顺序组装

**设计要点**：当前 `agent.ts:152` 串行 `for`。改并行 `Promise.all`，handoff 仍短路，结果按 map index 对齐保序。审批门不受影响（`executeTool` 内部自管 approvalMode）。**注意**：并行 `shell_run` 可能同时弹多个审批框——MVP 接受；同文件并行写由 LLM 负责避免。

- [ ] **Step 1: 写测试 `agent.test.ts`**

```ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi, beforeEach } from 'vitest'

// 路径相对 __dirname（vitest 下 cwd 不一定是项目根）——核验：Task 8b/9 同款写法统一改
const agentSrc = readFileSync(resolve(__dirname, '../agent.ts'), 'utf-8')

describe('agent tool loop parallel', () => {
  it('工具循环含 Promise.all（回归串行 for）', () => {
    expect(agentSrc).toContain('Promise.all')
    expect(agentSrc).not.toMatch(/for \(const tu of toolUses\)\s*\{[^}]*await executeTool/)
  })

  it('多个独立 tool_use 并行完成（耗时 ≈ max 而非 sum）', async () => {
    // mock executeTool：每个延迟 80ms；2 个并行工具总耗时应 < 150ms（串行会 > 150ms）
    vi.doMock('../../tools/registry', () => ({
      executeTool: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 80))
        return { content: '{"ok":true}', isError: false }
      }),
      listToolDefs: () => [],
    }))
    // 用 Agent + mock client 返回 2 个 tool_use，断言 wall time
    // 实现时读 agent-iterations.test.ts 的 mock 模式复用；测不过则至少保留上条源码断言
    expect(true).toBe(true) // placeholder：实现 Step 3 后替换为真实时序断言
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- agent`
Expected: FAIL（当前是串行 for）

- [ ] **Step 3: 改 `agent.ts:150-194` 并行**

```ts
const toolResults: LlmContentBlock[] = []
let handoffTarget: string | null = null

// handoff 短路（不并发，铁律12）
const handoffUses = toolUses.filter((tu) => isHandoffTool(tu.name))
const normalUses = toolUses.filter((tu) => !isHandoffTool(tu.name))

for (const tu of handoffUses) {
  handoffTarget = parseHandoffTarget(tu.name)
  toolResults.push({
    type: 'tool_result',
    tool_use_id: tu.id,
    content: JSON.stringify({ handoff_to: handoffTarget }),
    is_error: false,
  })
  logger.info(`[trace:cap] agent.handoff name=${this.config.name} → ${handoffTarget}`)
}

// 并行执行普通工具（顺序保真：map index 对齐 tool_use_id）
const normalResults = await Promise.all(
  normalUses.map(async (tu) => {
    functionCallCount++
    callbacks.onToolCall?.(tu.name, tu.input)
    const toolStarted = Date.now()
    const result = await executeTool(tu.name, tu.input, tu.id, {
      sessionId: this.deps.toolCtx?.sessionId,
      workspaceRoot: this.deps.toolCtx?.workspaceRoot,
      signal: input.signal,
      onPropose: this.deps.toolCtx?.onPropose,
      onAskUser: this.deps.toolCtx?.onAskUser,
      onApprove: this.deps.toolCtx?.onApprove,
    })
    callbacks.onToolResult?.(tu.name, result.content)
    logger.info(
      `[trace:cap] agent.tool name=${this.config.name} tool=${tu.name} ` +
        `err=${result.isError} ms=${Date.now() - toolStarted} resultLen=${result.content.length}`,
    )
    return {
      type: 'tool_result' as const,
      tool_use_id: tu.id,
      content: result.content,
      is_error: result.isError,
    }
  }),
)
toolResults.push(...normalResults)
```

- [ ] **Step 4: 测试通过 + 编排回归 + typecheck + commit**

```bash
npm test -- agent
npm test -- orchestrator
npm run typecheck
git add src/main/orchestrator/agent.ts src/main/orchestrator/agent.test.ts
git commit -m "feat: agent 工具循环并行执行（独立 tool_use 并发）
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: 系统提示词行为前缀

**Files:**
- Create: `src/main/tools/system-prefix.ts`
- Test: `src/main/tools/system-prefix.test.ts`
- Modify: `src/main/orchestrator/agent.ts:85`（**仅此一处**注入——禁止改 `home.ts` instructions）

**Interfaces:**
- Produces: `buildSystemPrefix(): string` — 框架级行为指令前缀

**设计要点**：最大杠杆（零成本让同模型变聪明）。照抄 Codex 指令骨架通用子集：autonomy（治"不够自主坚持"）+ tool guidelines（先 grep 再动手、工具并行、编辑后不重读）+ output style（按改动大小分档，治"回答质量差"）+ planning 引导（复杂任务先拆步，指向 Task 6 的 `update_plan` 工具）。不含编码专属 persona。

**单点注入（必须）**：首页路径是 `home.ts` 拼 `instructions` → `new Agent(config)` → `agent.ts:85` 再拼 system。若两处都调 `buildSystemPrefix()`，主 Agent 会被 **双注入**。因此 **只在 `agent.ts`** 调用；`home.ts` / `orchestrate.ts` 的 persona、路由、记忆段保持原样，由 Agent 统一前置前缀。

> **实现细节**：`agent.ts:85` 当前在 **每轮** `client.stream` 前执行 `injectRuntimeContext(this.config.instructions)`。接入前缀时应把 system 提升为 `run()` 入口处一次计算（`const system = injectRuntimeContext(`${buildSystemPrefix()}\n\n${this.config.instructions}`)`），避免每轮重复拼接；语义与现有一致。

- [ ] **Step 1: 写失败测试 `system-prefix.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { buildSystemPrefix } from './system-prefix'

describe('system-prefix', () => {
  it('返回非空字符串', () => {
    expect(buildSystemPrefix().length).toBeGreaterThan(300)
  })
  it('含 autonomy 纪律', () => {
    expect(buildSystemPrefix()).toContain('坚持到任务完全解决')
  })
  it('含工具并发指引', () => {
    expect(buildSystemPrefix()).toContain('并行')
  })
  it('含先搜索再动手', () => {
    expect(buildSystemPrefix()).toContain('grep')
  })
  it('含 output style 分档', () => {
    expect(buildSystemPrefix()).toContain('小改动')
  })
  it('含 planning 引导', () => {
    expect(buildSystemPrefix()).toContain('update_plan')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- system-prefix`
Expected: FAIL

- [ ] **Step 3: 实现 `system-prefix.ts`**

```ts
// —— 框架级行为指令前缀（所有 agent system prompt 前置）——
// 照抄 Codex 指令骨架的通用子集：autonomy / tool guidelines / output style / planning。
// 不含编码专属 persona（那是角色 agent 的事）。
// 拼装顺序：[本前缀] → [用户 instructions/persona] → [L0/记忆/路由段]

export function buildSystemPrefix(): string {
  return `# 行为纪律（框架级，适用于所有任务）

## 自主性
- 你是执行 agent。任务必须坚持到完全解决再结束，不要做一步就交回用户。
- 工具调用失败时，读返回的错误 JSON，调整参数重试，不要因一次失败就放弃。
- 优先用工具自主获取信息（grep/glob/file_read），减少反问用户。

## 规划
- 复杂任务（多步、多文件）先调用 update_plan 拆成步骤再动手。
- 每完成一步用 update_plan 标记进度，不要在正文里重复整个计划内容。

    ## 工具使用
- 独立的工具调用要并行发起（一轮内多个 tool_use），不要串行等上一个完。
- 搜索代码用 grep，查找文件用 glob，读文件用 str_replace_editor 的 view 命令或 file_read。
- 编辑文件用 str_replace_editor 的 str_replace/insert，不要整文件覆写来改一行。
- 编辑后不要立刻重读整个文件确认——工具已返回成功即可，除非要看改动的上下文。
- 若 grep/glob/str_replace 返回 no_workspace，说明当前会话未设项目路径——直接告知用户"请在当前页面顶部选择项目目录"（首页或编辑器页均有项目路径选择器），不要在笔记库里搜代码、不要反复重试。

## 输出风格
- 小改动（≤10 行）：2-5 句话或 ≤3 条要点，不加标题。
- 中等改动：≤6 条要点，按文件分组。
- 大改动/多文件：每个文件 1-2 条要点总结。
- 不要贴大段代码块、完整方法体或 before/after 对比——用户能自己看文件。`
}
```

- [ ] **Step 4: 测试通过**

Run: `npm test -- system-prefix`
Expected: PASS

- [ ] **Step 5: 接入 `agent.ts:85`（唯一注入点）**

```ts
import { buildSystemPrefix } from '../tools/system-prefix'
// ...
const system = injectRuntimeContext(`${buildSystemPrefix()}\n\n${this.config.instructions}`)
```

- [ ] **Step 6: 确认 home.ts 未重复注入**

读 `src/main/ipc/home.ts`：`instructions` 构造链 **不要** import / 调用 `buildSystemPrefix`。可加单测或 grep 回归：`home.ts` 不含 `buildSystemPrefix`。

- [ ] **Step 7: typecheck + 全量回归 + commit**

```bash
npm run typecheck && npm test
git add src/main/tools/system-prefix.ts src/main/tools/system-prefix.test.ts src/main/orchestrator/agent.ts
git commit -m "feat: 框架级行为指令前缀（autonomy/规划/工具并发/output style）
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: 规划工具（update_plan）

**Files:**
- Create: `src/main/tools/builtin/plan.ts`
- Test: `src/main/tools/builtin/plan.test.ts`
- Modify: `src/main/index.ts` + `src/main/tools/registry.ts`（ToolContext 加 planState）

**Interfaces:**
- Consumes: `ToolContext.planState`（可选，存当前会话的 plan，内存态即可——铁律"checkpoint 持久化 MVP 不做"）
- Produces: `registerPlanTool()`；工具名 `update_plan`，参数 `{ plan: Array<{ content: string; status: 'pending'|'in_progress'|'completed' }> }`；回调 `onPlanUpdate` 推前端

**设计要点**：对齐 Codex 的 `update_plan`。plan 状态内存态存 ToolContext（不持久化，符合 MVP 简化）。LLM 调用工具更新步骤状态，前端经事件流显示。治"理解/规划能力弱"——规划能力主要来自有工具可用 + 有纪律引导（Task 5 前缀已加 planning 段），模型本身不变。

- [ ] **Step 1: ToolContext 加 planState + onPlanUpdate**

`src/main/tools/registry.ts`：

```ts
export interface PlanStep {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface ToolContext {
  // ... 既有字段
  /** 当前会话的规划状态（内存态，MVP 不持久化） */
  planState?: PlanStep[]
  /** plan 更新回调 → 事件流推前端 */
  onPlanUpdate?: (plan: PlanStep[]) => void
}
```

- [ ] **Step 2: 写失败测试 `plan.test.ts`**

```ts
import { describe, expect, it, beforeEach } from 'vitest'
import { clearTools, executeTool, listToolDefs } from '../registry'
import { registerPlanTool } from './plan'
import type { PlanStep } from '../registry'

describe('tools/builtin/plan', () => {
  beforeEach(() => { clearTools(); registerPlanTool() })

  it('注册 update_plan', () => {
    expect(listToolDefs().map((t) => t.name)).toContain('update_plan')
  })

  it('更新 plan 并触发回调', async () => {
    let captured: PlanStep[] | null = null
    const r = await executeTool('update_plan', {
      plan: [
        { content: '读文件', status: 'completed' },
        { content: '改代码', status: 'in_progress' },
        { content: '跑测试', status: 'pending' },
      ],
    }, 'tu_1', { onPlanUpdate: (p) => { captured = p } })
    const d = JSON.parse(r.content)
    expect(d.ok).toBe(true)
    expect(d.plan.length).toBe(3)
    expect(captured).not.toBeNull()
    expect(captured![1].status).toBe('in_progress')
  })

  it('空 plan 报错', async () => {
    const r = await executeTool('update_plan', { plan: [] }, 'tu_2', {})
    expect(JSON.parse(r.content).ok).toBe(false)
  })
})
```

- [ ] **Step 3: 运行确认失败**

Run: `npm test -- plan`
Expected: FAIL

- [ ] **Step 4: 实现 `plan.ts`**

```ts
import { z } from 'zod'
import { registerTool } from '../registry'
import type { PlanStep } from '../registry'

const PlanSchema = z.object({
  plan: z.array(z.object({
    content: z.string().min(1),
    status: z.enum(['pending', 'in_progress', 'completed']),
  })).min(1),
})

export function registerPlanTool(): void {
  registerTool(
    'update_plan',
    '更新任务计划。复杂任务先用此工具拆成步骤，每完成一步标记进度。'
    + 'plan 是完整步骤列表（替换式，不是增量），每步有 content 和 status。'
    + '不要在正文里重复整个计划内容——本工具已记录。',
    PlanSchema,
    async (args, ctx) => {
      const input = args as z.infer<typeof PlanSchema>
      const plan: PlanStep[] = input.plan
      if (ctx) ctx.planState = plan
      ctx?.onPlanUpdate?.(plan)
      return { ok: true, plan }
    },
    'auto',
  )
}
```

- [ ] **Step 5: 测试通过 + 注册 + 注入回调 + typecheck + commit**

`src/main/index.ts` 加 `import { registerPlanTool } from './tools/builtin/plan'` + `registerPlanTool()`。

**allowlist 提醒**：注册后检查已设 `allowedToolNames` 的 agent/capability——白名单非空时须手动加入 `update_plan`，否则该资产看不到规划工具。

`home.ts` / `orchestrate.ts` 的 toolCtx 加 `onPlanUpdate`（推 `plan_update` 事件到前端，类似 `onPropose` 桥）。

```bash
npm test -- plan
npm run typecheck
git add src/main/tools/builtin/plan.ts src/main/tools/builtin/plan.test.ts src/main/tools/registry.ts src/main/index.ts src/main/ipc/home.ts src/main/ipc/orchestrate.ts
git commit -m "feat: update_plan 规划工具 + planning 纪律
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: token 感知截断（L1 + runner cache）

**Files:**
- Create: `src/main/llm/token-count.ts`
- Test: `src/main/llm/token-count.test.ts`
- Modify: `src/main/storage/memory/l1.ts` + `src/main/orchestrator/runner.ts:307`

**Interfaces:**
- Produces: `approxTokenCount(text: string): number`

**设计要点**：不接外部 tokenizer（Electron 分发不带额外二进制）。ASCII 4 字符≈1 token，CJK 1 字符≈1 token。L1 触发从"20条"改 token 阈值；cache 从"200条"改 token 截断。L1 压缩时 `textToCompress` 不再用 `[blocks]` 占位（当前 `l1.ts:80` 丢 tool 内容），改成把 tool_result 的实际内容拼进去。

- [ ] **Step 1: 写失败测试 `token-count.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { approxTokenCount } from './token-count'

describe('token-count', () => {
  it('ASCII 约 4 字符 1 token', () => {
    const t = approxTokenCount('hello world')
    expect(t).toBeGreaterThanOrEqual(2)
    expect(t).toBeLessThanOrEqual(4)
  })
  it('中文约 1 字符 1 token', () => {
    const t = approxTokenCount('你好世界')
    expect(t).toBeGreaterThanOrEqual(3)
    expect(t).toBeLessThanOrEqual(6)
  })
  it('空串 0', () => {
    expect(approxTokenCount('')).toBe(0)
  })
  it('混合文本返回正数', () => {
    expect(approxTokenCount('hello 你好')).toBeGreaterThan(3)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- token-count`
Expected: FAIL

- [ ] **Step 3: 实现 `token-count.ts`**

```ts
// —— 近似 token 计数（无外部依赖，跨平台分发安全）——
// ASCII 4 字符 ≈ 1 token；CJK 1 字符 ≈ 1 token。
// 用于 L1 压缩触发 + runner cache 截断阈值，替代消息条数启发式。

export function approxTokenCount(text: string): number {
  if (!text) return 0
  let ascii = 0
  let cjk = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c > 0x2e80 && c < 0x9fff) cjk++
    else if (c < 0x80) ascii++
    else cjk++
  }
  return Math.ceil(ascii / 4) + cjk
}

/** 累加 messages 的近似 token 数（content 是 string 或 blocks） */
export function messagesTokenCount(messages: Array<{ content: string | unknown[] }>): number {
  let total = 0
  for (const m of messages) {
    if (typeof m.content === 'string') total += approxTokenCount(m.content)
    else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (typeof b === 'object' && b !== null) {
          const block = b as { text?: string; content?: string }
          total += approxTokenCount(block.text ?? block.content ?? '')
        }
      }
    }
  }
  return total
}
```

- [ ] **Step 4: 测试通过**

Run: `npm test -- token-count`
Expected: PASS

- [ ] **Step 5: 改 L1 触发 + 压缩不丢 tool 内容**

`src/main/storage/memory/l1.ts`：

```ts
import { messagesTokenCount } from '../../llm/token-count'

const L1_TRIGGER_TOKENS = 12000  // 替代 L1_TRIGGER_MESSAGE_COUNT = 20
const L1_RECENT_WINDOW = 8

export async function maybeCompressL1(sessionId, messages, compressFn?) {
  // 触发条件：token 超阈值（不再用条数）
  if (messagesTokenCount(messages) < L1_TRIGGER_TOKENS) {
    return { summary: null, recentWindow: messages }
  }
  // ... toCompress / recentWindow 逻辑不变

  // textToCompress 不再用 '[blocks]' 占位——把 tool_result 实际内容拼进去
  const textToCompress = toCompress
    .map((m) => {
      if (typeof m.content === 'string') return `${m.role}: ${m.content}`
      // blocks：把 text / tool_result content 都拼出来
      const parts = (m.content as Array<{ type: string; text?: string; content?: string }>)
        .map((b) => b.text ?? b.content ?? '')
        .join('\n')
      return `${m.role}: ${parts}`
    })
    .join('\n')
  // ... 后续不变
}
```

- [ ] **Step 6: 改 runner cache 截断**

`src/main/orchestrator/runner.ts:307`：`CACHE_SOFT_CAP = 200`（条数）改 token 阈值。读 runner.ts 当前实现后，把 head+tail 截断逻辑用 `messagesTokenCount` 累加，超阈值（如 100000 token）时保头尾。

- [ ] **Step 7: typecheck + 回归 + commit**

```bash
npm run typecheck && npm test
git add src/main/llm/token-count.ts src/main/llm/token-count.test.ts src/main/storage/memory/l1.ts src/main/orchestrator/runner.ts
git commit -m "feat: token 感知截断（L1 触发 + runner cache + 压缩不丢 tool 内容）
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8a: 编排 cache 写入 tool 轨迹

**Files:**
- Modify: `src/main/orchestrator/patterns/agent.ts:52-85`
- Modify: `src/main/orchestrator/agent.ts`（`onToolCall` / `onToolResult` 传 `toolUseId`）
- Modify: `src/shared/types.ts`（`AgentRunCallbacks` 扩展）
- Test: `src/main/orchestrator/patterns/agent.test.ts`

**Interfaces:**
- Consumes: `AgentRunCallbacks` 扩展为 `onToolCall?(name, args, toolUseId)` / `onToolResult?(name, content, toolUseId)`
- Produces: `AgentExecutor` 在 `Agent.run` 期间把 tool_use / tool_result 写入 `this.cache`（带 `toolUseId` / `isFunctionResult`）

**设计要点（比 assembleMessages 更根本的根因）**：当前 `handle` 跑完后 **只** push `{ role: 'assistant', content: result.finalText }` 到 cache（`patterns/agent.ts:81-85`）。上游 agent 内部调用的 grep/file/shell 轨迹从未进 cache，runner 全量转发 cache 给下游时也无可转发的 tool 块。**Task 8b 修 assembleMessages  alone 不够**——须先在本 Task 把 tool 轨迹写入 cache。

> **与 Task 4 并行执行的交互（须在 Task 8a 前完成 Task 4）**：
> Task 4 并行执行后，`onToolCall` 回调在 `Promise.all` 的 map 起始同步触发（顺序保真），但 `onToolResult` 回调按各工具完成时序触发（可能与 tool_use 顺序不一致）。例如两个工具 A→B 并行，cache 物理顺序可能为 `tool_use_A → tool_use_B → result_B → result_A`（非 `A→result_A→B→result_B`）。
>
> 这**不影响**配对正确性：`repairToolPairs` 按 `toolUseId` 集合匹配（非物理位置），`assembleMessages` 的 tool_result block 用 `tool_use_id` 字段引用（非位置依赖）。`assembleMessages` 同角色相邻合并时，乱序的 result_B + result_A 会被合并为同一条 user 消息的两个 tool_result block——这是正确行为。
>
> 但 **`finalText` push 时序须注意**：`finalText` 在 `Promise.all` resolve 后 push（所有 result 已写入 cache），故 finalText 始终在所有 tool 轨迹之后——顺序正确。

- [ ] **Step 1: 扩展 `AgentRunCallbacks`**

`src/shared/types.ts`：

```ts
export interface AgentRunCallbacks {
  onText?: (text: string) => void
  onThinking?: (text: string) => void
  onToolCall?: (tool: string, args: unknown, toolUseId: string) => void
  onToolResult?: (tool: string, result: unknown, toolUseId: string) => void
  onRetry?: (info: RetryInfo) => void
}
```

`agent.ts` 里 `callbacks.onToolCall?.(tu.name, tu.input, tu.id)` / `onToolResult?.(tu.name, result.content, tu.id)` 同步改签名。

- [ ] **Step 2: AgentExecutor callbacks 写入 cache**

`patterns/agent.ts` 的 `handle` 内，`AgentRunCallbacks` 改为：

```ts
const callbacks: AgentRunCallbacks = {
  onText: (text) => { /* output 事件不变 */ },
  onThinking: () => {}, // Task 9 再改
  onToolCall: (tool, _args, toolUseId) => {
    // assistant 侧 tool_use 占位：content 摘要供无-tool 下游降级时仍有文本
    this.cache.push({
      role: 'assistant',
      author: this.id,
      content: `[tool:${tool}]`,
      toolUseId,
    })
  },
  onToolResult: (tool, result, toolUseId) => {
    this.cache.push({
      role: 'user',
      author: this.id,
      content: typeof result === 'string' ? result : JSON.stringify(result),
      toolUseId,
      isFunctionResult: true,
    })
  },
}
```

跑完后 **仍** push `finalText` assistant 消息（供 yield_output / 无 tool 下游读摘要）；顺序为：…tool 对…→ finalText。

- [ ] **Step 3: 写测试**

`patterns/agent.test.ts`：mock `Agent.run` 触发 onToolCall/onToolResult，断言 `executor.cache` 含带 `toolUseId` 的条目且 `isFunctionResult` 配对正确。

- [ ] **Step 4: 回归 + commit**

```bash
npm test -- patterns/agent
npm test -- sequential
npm run typecheck
git add src/main/orchestrator/patterns/agent.ts src/main/orchestrator/agent.ts src/shared/types.ts src/main/orchestrator/patterns/agent.test.ts
git commit -m "feat: AgentExecutor cache 写入 tool 轨迹（多 agent 上下文保真前置）
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8b: 编排路径条件化 assembleMessages

**Files:**
- Modify: `src/main/orchestrator/patterns/agent.ts:96-126`
- Modify: `src/main/orchestrator/constraints.ts`（复用 `stripToolBlocksFilter` / `repairToolPairs`）
- Test: `src/main/orchestrator/patterns/agent.test.ts` + `constraints.test.ts` 回归

**Interfaces:**
- Consumes: `OrchMessage`（`toolUseId` / `isFunctionResult` 已有，`shared/types.ts:176-178`）
- Produces: `assembleMessages` 按 **本 agent 是否带 tools** 分支

**设计要点**：

| 本 agent 是否带 tools | 行为 | 依据 |
|---|---|---|
| 有 tools（`config.tools?.length` 或 `toolNames?.length` > 0） | `repairToolPairs(cache)` → 保留 tool_use/tool_result 配对 → block 级合并同角色 | 铁律16-18 |
| 无 tools | `stripToolBlocksFilter(cache)` → 只留文本（治 Anthropic 2013） | 回归测试在 `constraints.test.ts:67-80`（**非** sequential.test.ts——核验：`find src -name "*.test.ts" \| xargs grep -l stripTool` 仅命中 `constraints.test.ts`） |

不可无脑保留全部 tool 块——无 tool 下游收到上游 tool_result 会触发 Anthropic 2013。

> **`stripToolBlocksFilter` 对 tool_use 占位的处理（Task 8a 前置依赖）**：
> 现有 `stripToolBlocksFilter` 只移除 `isFunctionResult=true` 的 tool_result 消息，**不移除** assistant 侧的 tool_use 占位消息（`toolUseId` set, `isFunctionResult` falsy）。Task 8a 写入 cache 的 tool_use 占位 `content: '[tool:grep]'` 会在 strip 后保留，作为纯文本流到无-tools 下游——这是有意的（让下游知道上游调了什么工具）。
>
> 须保证占位 content 非空：`assembleMessages` 的 `else` 分支直接用 `m.content`，若为空字符串会产出空 text 块，触发 Anthropic "text content blocks must be non-empty"。Task 8a 的 `onToolCall` 已写 `[tool:${tool}]` 非空占位——若未来改为空 content，须在 `stripToolBlocksFilter` 或 `assembleMessages` 中加空内容兜底（如 `repairToolPairs` 的 `[工具调用]` 占位模式）。

- [ ] **Step 1: 写失败测试**

```ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// 路径相对 __dirname（vitest 下 cwd 不一定是项目根）——核验：Task 4/9 同款写法也统一改
const agentSrc = readFileSync(resolve(__dirname, '../agent.ts'), 'utf-8')

describe('AgentExecutor assembleMessages', () => {
  it('有 tools 时保留 isFunctionResult（源码含条件化分支，非裸 continue）', () => {
    // 应含 stripToolBlocksFilter 或 hasTools 分支，而非裸 continue
    expect(agentSrc).toMatch(/stripToolBlocksFilter|hasTools|tools\?\.length/)
  })
})
```

- [ ] **Step 2: 重写 `assembleMessages`**

```ts
import { repairToolPairs, stripToolBlocksFilter } from '../constraints'

private assembleMessages(_ctx: WorkflowContext): LlmMessage[] {
  // config 是 public（agent.ts:58 `public config: AgentConfig`），直接访问。
  // tools 是可选字段（types.ts:779 `tools?: LlmToolDef[]`），须 ?? 0 防炸。
  // resolveTools() 是 private（agent.ts:246）不能从外部调，这里自己算。
  const hasTools = (this.agent.config.tools?.length ?? 0) > 0
    || (this.agent.config.toolNames?.length ?? 0) > 0
  let source = [...this.cache]
  source = hasTools ? repairToolPairs(source) : stripToolBlocksFilter(source)

  const messages: LlmMessage[] = []
  for (const m of source) {
    const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user'
    let content: LlmMessage['content']
    if (hasTools && m.isFunctionResult) {
      content = [{ type: 'tool_result', tool_use_id: m.toolUseId ?? '', content: m.content }]
    } else if (hasTools && m.toolUseId && !m.isFunctionResult) {
      // tool_use 块：若 cache 只有占位文本，可包 text；完整 block 流后续迭代
      content = m.content
    } else {
      content = m.content
    }
    const last = messages[messages.length - 1]
    if (last && last.role === role) {
      if (typeof last.content === 'string' && typeof content === 'string') {
        last.content = `${last.content}\n\n${content}`
      } else {
        const lastBlocks = typeof last.content === 'string'
          ? [{ type: 'text' as const, text: last.content }] : last.content as unknown[]
        const curBlocks = typeof content === 'string'
          ? [{ type: 'text' as const, text: content }] : content as unknown[]
        last.content = [...lastBlocks, ...curBlocks] as LlmMessage['content']
      }
    } else {
      messages.push({ role, content })
    }
  }

  // wake_on_upstream 不变
  const last = messages[messages.length - 1]
  if (last?.role === 'assistant') {
    const lastCache = this.cache[this.cache.length - 1]
    if (lastCache?.author && lastCache.author !== this.id) {
      messages.push({ role: 'user', content: '请基于上游信息继续，输出你的部分。' })
    }
  }
  return messages
}
```

> 核验根据：
> - `OrchMessage.toolUseId` 在 `shared/types.ts:176`，`isFunctionResult` 在 178 行——**已存在，无需加字段**。
> - `Agent.config` 是 `public`（`agent.ts:58`），直接 `this.agent.config.tools` 即可，**不需要** `as Agent` cast，也**不需要**改 Agent 暴露 `hasTools()`。
> - `config.tools` 是可选（`types.ts:779` `tools?: LlmToolDef[]`），**必须** `?? 0` 否则 undefined.length 会抛。
> - `resolveTools()` 是 `private`（`agent.ts:246`），AgentExecutor 不能调，自己算 `tools?.length || toolNames?.length`。

- [ ] **Step 3: 全量编排回归 + commit**

```bash
npm test -- patterns/agent
npm test -- constraints          # stripToolBlocksFilter / repairToolPairs 回归（非 sequential）
npm test -- sequential           # sequential 模式端到端
npm test -- orchestrator
npm run typecheck
git add src/main/orchestrator/patterns/agent.ts src/main/orchestrator/patterns/agent.test.ts
git commit -m "fix: assembleMessages 条件化保 tool 块（有 tools 保留配对，无 tools strip）
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: 编排模式保留 thinking

**Files:**
- Modify: `src/main/orchestrator/patterns/agent.ts:65`
- Test: `src/main/orchestrator/patterns/agent.test.ts`

**Interfaces:**
- Produces: `AgentExecutor` 的 `onThinking` 转发到事件流（新 StreamEvent 类型或复用 output 加 speaker 标记）

**设计要点**：当前 `patterns/agent.ts:65` `onThinking: () => {}`——编排模式推理过程完全丢弃，用户和下游看不到 agent 在想什么。修复：转发到事件流。当前注释说"编排 orch_event 流只有 output 一类，thinking 混进会被当正文渲染"——解法是给 StreamEvent 加 `type: 'thinking'` 变体（或在 output 事件加 `kind: 'thinking'` 字段），前端按 kind 分流渲染。

- [ ] **Step 1: 写失败测试**

在 `patterns/agent.test.ts` 加：

```ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const patternsAgentSrc = readFileSync(resolve(__dirname, '../patterns/agent.ts'), 'utf-8')

it('onThinking 不再是空函数（转发到事件流）', () => {
  expect(patternsAgentSrc).not.toContain('onThinking: () => {}')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- patterns/agent`
Expected: FAIL（当前正是 `onThinking: () => {}`）

- [ ] **Step 3: 给 StreamEvent 加 thinking 变体 + 转发**

读 `shared/types.ts` 的 `StreamEvent` 定义，加 `type: 'thinking'` 变体（含 `node_id` / `speaker` / `text`，结构同 output）。

`patterns/agent.ts:52-66` 的 callbacks 改：

```ts
const callbacks: AgentRunCallbacks = {
  onText: (text) => {
    void ctx.add_event({ type: 'output', node_id: this.id, speaker: this.id, text })
  },
  onThinking: (text) => {
    // 转发推理到事件流（独立 thinking 事件，前端按 type 分流渲染，不混进正文）
    void ctx.add_event({ type: 'thinking', node_id: this.id, speaker: this.id, text })
  },
}
```

- [ ] **Step 4: 前端按 type 分流渲染**

读 `renderer/src/components/orchestra/` 下渲染 StreamEvent 的组件，加 `thinking` 事件分支（折叠展示或灰字，不混进正文）。具体组件名实现时确认。

- [ ] **Step 5: 测试通过 + typecheck + commit**

```bash
npm test -- patterns/agent
npm run typecheck
git add src/main/orchestrator/patterns/agent.ts src/shared/types.ts src/renderer/src/components/orchestra/
git commit -m "feat: 编排模式保留 thinking（转发到事件流，不再 onThinking:()=>{}）
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review

**1. 现象覆盖**：
- 不够自主坚持 → Task 5 autonomy 段 ✅
- 上下文/记忆不行（单 agent）→ Task 7 ✅
- 上下文/记忆不行（多 agent）→ Task 8a（cache 写入）+ Task 8b（条件化 assembleMessages）✅
- 推理过程不可见（编排）→ Task 9 ✅
- 理解/规划能力弱 → Task 5 planning 段 + Task 6 ✅
- 回答质量/表达差 → Task 5 output style 段 ✅
- 工具有了够不到代码 → Task 0 ✅
- 多步操作慢 → Task 4 ✅
- 行级编辑/代码搜索 → Task 1/2/3 ✅
- shell 审批差距 / Editor 无 cwd → §已知边界 + Task 0 Step 7b ✅

**2. Review 修正记录（2026-08-10）**：
- Task 8 拆为 8a（cache 写入 tool 轨迹）+ 8b（按 hasTools 条件化 strip/保留）——修复「只改 assembleMessages 不够」与铁律16 冲突
- Task 5 改为 **仅** `agent.ts` 注入，删除 `home.ts` 重复前缀
- 根因表 Task 10 → Task 6；删除 File Structure 中 SettingsPage
- Task 2/3 补性能边界与 glob 相对路径匹配
- Task 4 补并行时序测试意图；Task 0 补 EditorPage Step 7b
- Global Constraints 补 allowlist / 单点注入 / 条件化铁律16-18

**3. Placeholder scan**：
- Task 4 Step 1 并行时序测试含 placeholder——Step 3 后替换为真实 mock 断言
- Task 9 Step 4 前端组件名标注"实现时确认"——同上
- Task 7 Step 6 runner.ts 截断标注"读当前实现后改"——同上
- ~~Task 8b Step 2 `Agent` 私有访问~~ **已修正（2026-08-10 核验）**：`config` 是 public（agent.ts:58），直接 `this.agent.config.tools?.length ?? 0`，不需要 cast、不需要改 Agent 暴露 hasTools()

**4. Type consistency**：
- `workspaceRoot?: string` 贯穿 Task 0 → Task 1/2/3 → Task 4 一致
- `PlanStep` / `planState` / `onPlanUpdate` 在 Task 6 定义；Task 5 前缀引用 `update_plan`（工具 Task 6 后注册，顺序 5→6 正确）
- `OrchMessage.toolUseId` 已存在于 `shared/types.ts:176`，Task 8a/8b 直接用
- `AgentRunCallbacks` 扩展 `toolUseId` 参数——Task 8a 与 `agent.ts` 同步
- **Task 8b `hasTools` 判定**：`config.tools` 可选（types.ts:779），必须 `(config.tools?.length ?? 0) > 0 || (config.toolNames?.length ?? 0) > 0`——核验 `resolveTools()`（agent.ts:246-249）正是此三态逻辑
- **Task 5 与 system 拼装时机**：`agent.ts:85` 当前每轮 `client.stream` 前重算 `injectRuntimeContext(...)`；Task 5 接入 `buildSystemPrefix()` 时建议把 system 提升为 `run()` 入口处的 `const system = ...`（避免每轮重复拼接），语义不变

**5. 核验修正记录（2026-08-10 代码对照）**：
- `stripToolBlocksFilter` 回归测试在 `constraints.test.ts:67-80`，**非** `sequential.test.ts:129`——`find src -name "*.test.ts" | xargs grep -l stripTool` 仅命中 constraints.test.ts
- `OrchMessage.toolUseId`（types.ts:176）/ `isFunctionResult`（178 行）已存在，Task 8a/8b 无需加字段
- `Agent.config` 是 `public`（agent.ts:58），Task 8b 直接访问，不需要 `as Agent` cast
- `config.tools` 是可选字段（types.ts:779 `tools?: LlmToolDef[]`），`tools.length` 会炸——改 `tools?.length ?? 0`
- Task 4/8b/9 测试文件读取改用 `resolve(__dirname, '...')` 而非 cwd 相对路径——vitest 下 cwd 不保证是项目根

## 执行顺序

按 ROI + 依赖排序：

1. **Task 5**（系统前缀，**仅 agent.ts**）— 成本最低、杠杆最大、无依赖
2. **Task 0**（项目根 + HomePage/EditorPage 选择器）— 编码工具前置
3. **Task 1/2/3**（str_replace / grep / glob）— 依赖 Task 0 围栏导出
4. **Task 4**（并行）— 依赖 Task 0 的 workspaceRoot 注入；**宜在 Task 8a 前完成**（cache 写入与并行 tool 回调交互）
5. **Task 6**（规划工具）— 依赖 Task 5 前缀的 planning 引导
6. **Task 7**（token 感知）— 独立，可与 8 并行
7. **Task 8a**（cache 写入 tool 轨迹）— 多 agent 保真前置
8. **Task 8b**（条件化 assembleMessages）— 依赖 8a 有数据可组装；**必须**跑 `constraints.test.ts` + `sequential.test.ts` 回归
9. **Task 9**（保留 thinking）— 与 8 同文件，放最后减少 merge 冲突

**关键修正**：多 agent「失忆」是 **cache 未写入 tool 轨迹（8a）** + **assembleMessages 无条件 strip（8b）** 两层问题；只修一层收益不完整。Task 8b 对无 tools 下游 **必须** 继续 strip（铁律16，`constraints.test.ts:67-80`），不可一律保留 tool 块。

### 执行顺序依赖补充（Task 4 ↔ 8a）

Task 4 把 `agent.ts` 工具循环改并行后，`onToolCall` / `onToolResult` 的调用时序变化会直接影响 Task 8a 的 cache 写入顺序：

- **onToolCall**：在 `Promise.all` 的 `map` 起始同步触发 → cache 中 tool_use 占位顺序与 toolUses 一致
- **onToolResult**：按各工具完成时序触发 → cache 中 tool_result 物理顺序可能乱序（result_B 在 result_A 前）
- **正确性不受影响**：`repairToolPairs` 按 `toolUseId` 集合匹配（非位置），`assembleMessages` 的 tool_result block 用 `tool_use_id` 字段引用
- **finalText**：`Promise.all` resolve 后 push，始终在所有 tool 轨迹之后

因此 Task 8a 的测试（`patterns/agent.test.ts`）应在 Task 4 合并后写——若 Task 4 未做，Task 8a 先跑则测试会按串行时序写死，后续 Task 4 上线可能误报失败。
