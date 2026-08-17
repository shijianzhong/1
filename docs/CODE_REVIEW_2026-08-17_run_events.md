# Code Review：run_events 运行时事实流落地

- **日期**：2026-08-17
- **范围**：`run_events` 观测层首批落地（storage / IPC / orchestrator / tools 注入 + 测试）
- **改动文件**：`src/main/storage/{db.ts,runEvents.ts,runEvents.test.ts}`、`src/main/ipc/{runs.ts,index.ts,home.ts,orchestrate.ts}`、`src/main/orchestrator/{runner.ts,runner.runEvents.test.ts,home.ts,agent.ts}`、`src/main/tools/{registry.ts,registry.runEvents.test.ts}`、`src/shared/types.ts`
- **结论**：设计扎实（观测层松耦合 / payload 8KB 护栏 / seq 按 run 单调 / `endRun` 防双写 / 写失败不抛不打断业务 / 测试覆盖全链路），但有 **3 个真问题 + 2 个待确认项**。P0 是本次改动自身引入的泄漏，优先修。

---

## 问题清单（按严重度）

### 🔴 P0：`startRun` 在 `try` 之前——异常时 run 行永久卡 `running`

观测层本应「不打断业务」，这里反而造了一个状态泄漏：run 行永远收不了口。

**home.ts**（`startRun` @232 → 内层 `try` @670，中间约 438 行）：

232 之后、670 之前的可抛点（任一抛出即触发本 bug）：
- 238 `throw new IpcErrorThrow('errors:home.no_provider')`（未配 provider）
- 243 `throw new IpcErrorThrow('errors:home.no_default_model')`
- 245 `makeCompressFn` / 附件处理 / L0 注入 / `homeSkillProvider.beforeRun` / 意图路由指令拼装 / HITL 桥注入等

这些 throw 落在内层 `try`(670) **之外**——内层 `catch`(1005) 管不到——会冒到外层 `withHandler` 的 catch（返回失败 `IpcResult`），**但 `endRun` 永远不会被调用**。runs 表里这个 run 行就永远 `status='running'`、`ended_at=NULL`。

**orchestrate.ts**（`startRun` @289 → `try` @301，中间 3 行但含异步）：
- 290 `await listToolsForAgents()`（MCP 连接 / 网络）
- 297 `buildWorkflow(graph, deps)`（图校验）

同理，这两行抛异常时 `catch`(321) 还没进，run 卡 `running`。

#### 修复指引

> ⚠️ home.ts 的 `try` 不能简单上移到 233——catch(1005) 引用了 `signal` 与 `hitlRunId`，而这两个变量声明在 **388/389**（`abortController` @388、`hitlRunId` @389），在 238 抛异常时尚未执行到 → catch 里会 `ReferenceError`。核实过：`grep` 确认 `const abortController` @388、`const hitlRunId` @389。

两个安全方案：

**方案 A（推荐，最小改动）**：把 `endRun` 收口从内层 catch 上提到一个**包住 `startRun` 的外层 try**，且 catch 里**不引用** signal/hitlRunId/skillProviders——用一个独立的防御块：

```ts
startRun({ id: eventsRunId, sessionId: sid, entry: 'home' })
try {
  // ...原 234–1025 全部代码（含原内层 try/catch/finally）...
} catch (e) {
  // 外层兜底：只收口 run 状态，不碰可能未声明的变量
  try { endRun(eventsRunId, 'error') } catch {}
  try { appendRunEvent(eventsRunId, 'home.run.failed', {
    error: e instanceof Error ? e.message : String(e), phase: 'pre_try',
  }, sid) } catch {}
  throw e
}
```

原内层 try/catch/finally 保持不动（它管 signal.aborted 的细分语义和 afterRun）。两层 catch 的 `endRun` 不会冲突——`endRun` 的 SQL 带 `WHERE status='running'`，重复收口只首次生效（已有单测覆盖）。

**方案 B**：把 `abortController` / `hitlRunId` 声明提前到 `startRun` 之前（232 之前），再把内层 `try` 起点上移到 233。改动面更大、变量语义前置，但 catch 能安全引用 signal。不推荐，除非本来就想重构声明顺序。

orchestrate.ts 简单：`signal` @285 在 `startRun` @289 之前已声明，把 `try` @301 起点上移到 290 即可，catch(321) 里 `signal.aborted` 安全。

#### 补测

修完后补一个单测：`startRun` 之后、`try` 之前注入一个会抛异常的步骤（mock `getDefaultProvider` 返回 null），断言 run 行最终 `status='error'` 而非 `running`。当前测试集没有覆盖这个场景——正好是 bug 本身，所以没测到。

---

### 🟡 P1：preload 未暴露 `runs` 命名空间——`runs:list`/`runs:detail` 是死通道

- `src/main/ipc/runs.ts` 注册了 `runs:list` / `runs:detail` 两个 handler
- `src/main/ipc/index.ts` 调了 `registerRunsHandlers()`
- 但 **preload 的 `OneApi` 接口与 `window.one.*` 实现里完全没有 `runs` 命名空间**（`grep -n "runs" src/preload/index.ts` 零命中）

按铁律2，渲染层只调 `window.one.*`、不裸用 `ipcRenderer` → 这两个通道目前**渲染层根本调不到**，run 诊断时间线在前端拿不到。`RunInfo`/`RunEventInfo` 在 `shared/types.ts` 已定义却无人消费。

#### 修复指引

在 preload `OneApi` 接口补：

```ts
runs: {
  list: (input?: { sessionId?: string; limit?: number }) => Promise<IpcResult<RunInfo[]>>
  detail: (input: { runId: string }) => Promise<IpcResult<{ run: RunInfo | null; events: RunEventInfo[] }>>
}
```

实现侧 `window.one.runs = { list, detail }` 两个 `ipcRenderer.invoke` 映射，与现有 `registry`/`topics` 命名空间同模式。

若这批先不做前端查看（纯 SQL 层、未来用），则至少在 `runs.ts` 顶部注释说明「此通道暂未对渲染层暴露，主进程/诊断脚本直连 SQL」，并把 `RunInfo`/`RunEventInfo` 标注为「预置契约」。但既然查询层和 shared types 都做了，补 preload 才闭环——推荐补。

---

### 🟡 P1：`home.chat` abort 路径路由断档（低优先级，记录即可）

abort 落在 `catch`(1005)：只 `endRun('aborted'/'error')` + `home.run.failed`，**没 `setRunRoute`、也没 `home.route.decided` 事件**。若 abort 发生在终判路由之前（直答进行到一半被 cancel），前端时间线显示 `started → failed`，中间路由段空白。

可接受（abort 本就未必走到终判），但要意识到：runs 表 `route=NULL` 对这类 run 是「未决」而非「无路由」语义，前端展示需区分。不阻塞，记录。

---

### 🟢 待确认 1：`appendRunEvent` 在 runner 热循环里每 superstep 同步写 DB

`node.scheduled`（每 superstep 一次）+ 每 executor 的 `node.started`/`node.completed`/`node.cache_extended`。一次 groupchat 50 superstep × N 节点 = 上百次同步 SQLite 写。better-sqlite3 同步阻塞主进程；虽然单次写 sub-ms，但叠加 LLM 流式解码同在主进程，密集时段可能抖动。

**不是 bug，是取舍**。若后续观测到卡顿，再批量化（superstep 结束一次性 flush）或确认 WAL 模式下已足够轻。现在不动，记为观测点。

---

### 🟢 待确认 2：`run_events` 无清理策略

db.ts v9 注释写了「删会话不级联清事件（诊断数据独立生命周期，清理策略后续单独定）」——有意的。但 `run_events` 是无界增长表（AUTOINCREMENT + 不删），长期使用会膨胀。

建议后续补 `deleteRunEventsBefore(ts)` + 设置页/启动清理 N 天前数据钩子，或文档记 TODO。不阻塞。

---

## 测试评价

三个测试文件（`runEvents.test.ts` / `registry.runEvents.test.ts` / `runner.runEvents.test.ts`）质量高：
- 覆盖生命周期、seq 单调、payload 截断、孤儿事件、seq 竞态假设、precheck/approval/session_bypass/重试耗尽、broadcast 的 `cache_extended` vs `started`、executor 抛错、无 runId 零副作用
- 断言用 `toMatchObject` 只断关键字段，不脆
- mock 边界清晰（`appendRunEvent` mock 只验事件、落库由 `runEvents.test.ts` 独立覆盖）

**唯一缺口**：无测试覆盖「`startRun` 后、`try` 前抛异常时 run 行卡 `running`」——正好是 P0 bug 本身，测试自然没覆盖到。修 P0 后补。

---

## 建议动手顺序

1. **P0 修复**（home.ts 方案 A + orchestrate.ts 上移 try）+ 补 P0 单测
2. **P1 preload 补 `runs` 命名空间**（若确认要做前端时间线）
3. P1 abort 路由断档、待确认 1/2 → 记录，不阻塞本批

等你确认范围后我再动手。
