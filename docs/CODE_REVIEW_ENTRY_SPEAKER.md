# 代码审查：入口解析与 Speaker 显示

> 审查日期：2026-07-31
> 审查范围：当前未提交工作区改动（`git diff`），涉及 `builder.ts`、`ipc/home.ts`、`ipc/orchestrate.ts`、`EditorPage.tsx`、`HomePage.tsx`、`AgentNodeView.tsx`、`ContainerNodeView.tsx`、`app.css`、i18n JSON
> 审查基准：结合运行时机制（runner / executor 注册 / StreamEvent 链路）与设计文档（铁律20、CLAUDE.md）

---

## 一、改动背景

本次改动围绕**铁律20**（`executor_id == agent name == ReactFlow 节点 id`，定义于 `CLAUDE.md:135`）解决编排引擎三个核心问题：

| 问题 | 根因 | 涉及改动 |
|------|------|----------|
| 空白气泡 | executor 注册用 `d.label`（角色显示名）而非 `node.id`，runner 的 `executors.get(node.id)` 找不到 | `home.ts` / `orchestrate.ts` 的 `name: node.id` |
| 容器入口空输出 | `startExecutor = graph.nodes[0]?.id`，若 `nodes[0]` 是 sequential 容器（不注册 executor），runner 找不到 | `builder.ts` 新增 `resolveStartExecutor` |
| Speaker 显示原始 id | `speaker` 字段存的是 `executor_id`（== `node.id`），前端直接显示 | `HomePage.tsx` 新增 `speakerName` 映射 |

---

## 二、运行时验证事实

以下结论均基于代码事实，非推测。

### 2.1 Runner 查找 executor 的机制

- **入口**：`runner.ts:142-149`，初始消息投递到 `wf.startExecutor`
- **查找**：`runner.ts:180-186`，`wf.executors.get(targetId)`，找不到则 `logger.warn('未找到 executor，跳过')` → 空输出
- **注册 key**：`builder.ts:41-43`，`executors.set(e.id, e)`；`e.id` 来自 `opts.config.name`（`agent.ts:32`）

**结论**：`config.name` 必须等于 `node.id`，否则 runner 查不到 executor。

### 2.2 各容器类型的 executor 注册情况

| 容器类型 | 是否注册容器 executor | 注册代码 | key |
|---------|---------------------|---------|-----|
| sequential | **否** | `sequential.ts:20-45` 只注册 participant + 配线性边 | — |
| concurrent | 是 | `concurrent.ts:74-76` `new ConcurrentExecutor(node.id, ...)` | `node.id` |
| groupchat | 是 | `groupchat.ts:304-312` `new GroupChatExecutor({id: node.id, ...})` | `node.id` |
| handoff | 是 | `handoff.ts:113-114` `new HandoffExecutor(node.id, ...)` | `node.id` |

### 2.3 Speaker 全链路

```
config.name (= node.id)
  → AgentExecutor.id = config.name              (patterns/agent.ts:32)
  → StreamEvent.output.speaker = this.id         (patterns/agent.ts:57)
  → HomeStreamEvent.orch_event.event             (ipc/home.ts:509 转发)
  → ChatMessage.speaker = ev.speaker             (HomePage.tsx:169)
  → speakerName(m.speaker)                       (HomePage.tsx:61-66)
```

### 2.4 node.id 的两种来源

| 路由路径 | 图来源 | node.id 格式 | speakerName 映射 |
|----------|--------|-------------|-----------------|
| @角色直跳（`directAgent`） | `buildTeamGraph` → `agentNodeFromAgent`（`home.ts:458`） | `a.id`（`agt_xxx`） | **成功** |
| @能力直跳（`directCap`） | 跑 `cap.graph`（用户画布图） | `agent_${Date.now().toString(36)}`（`EditorPage.tsx:414`） | **失败** |
| 主Agent组队 | `buildTeamGraph` → `agentNodeFromAgent/Capability` | `agt_xxx` / `cap_xxx` | **成功** |
| 能力图直接跑 | `cap.graph` | 画布生成 id | **失败** |

---

## 三、问题清单

### P1：`speakerName` 对画布图节点映射失败

**位置**：`src/renderer/src/pages/HomePage.tsx:61-66`

**现象**：用户在画布编辑器里画了一个能力图，节点 id 是 `agent_ms76ai3a`（`EditorPage.tsx:414`），节点 `data.sourceAgentId` 是 `agt_wechat_writing`。运行时 `speaker = agent_ms76ai3a`，`speakerName` 在 `agentsQ.data`（id = `agt_xxx`）中找不到，fallback 返回 `agent_ms76ai3a`，气泡头部显示无意义的时间戳 id。

**根因**：`speakerName` 只按 `Agent.id` / `Capability.id` 查找，未覆盖画布生成的 node.id。后端 builder 有 `findAgentNode`（`builder.ts:184-191`）做 sourceAgentId 回退，但那只用于 executor 解析，不影响 speaker 值。

**影响范围**：`@能力直跳` 和「能力图直接跑」路径，画布节点 speaker 显示异常。`@角色直跳` 和「主Agent组队」路径不受影响（node.id 就是库 id）。

**建议修复**（前端方案，轻量）：

```typescript
const speakerNameMap = useMemo(() => {
  const m = new Map<string, string>()
  for (const a of agentsQ.data ?? []) m.set(a.id, a.name)
  for (const c of capabilitiesQ.data ?? []) {
    m.set(c.id, c.name)
    // 遍历能力图节点，建立画布 node.id → label 映射
    for (const n of c.graph?.nodes ?? []) {
      const label = (n.data as { label?: string })?.label
      if (label) m.set(n.id, label)
    }
  }
  return m
}, [agentsQ.data, capabilitiesQ.data])

const speakerName = useCallback(
  (id: string) => speakerNameMap.get(id) ?? id,
  [speakerNameMap],
)
```

---

### P2：`entryInfo` 未 memoize 导致 `displayNodes` useMemo 失效

**位置**：`src/renderer/src/pages/EditorPage.tsx:857-867`

**现象**：`entryInfo` 是一个 IIFE，每次渲染都返回新对象，`effectiveEntryId` / `hasExplicitEntry` 引用每次都变。下游 `displayNodes` 的 `useMemo` deps 依赖这两个值，导致 memo 永远不命中，每次渲染都重新生成 `displayNodes` 数组。

**影响**：节点数量多时有性能浪费，ReactFlow 的节点 diffing 无法跳过未变更节点。

**建议修复**：

```typescript
const entryInfo = useMemo(() => {
  const topLevel = nodes.filter((n) => !n.parentId)
  const hasIncoming = new Set(edges.map((e) => e.target))
  const explicit = topLevel.filter((n) => (n.data as { isEntry?: boolean }).isEntry === true)
  if (explicit.length > 0) {
    return { id: explicit[0].id, explicit: true }
  }
  const topo = topLevel.filter((n) => !hasIncoming.has(n.id))
  const derived = topo[0] ?? nodes[0]
  return derived ? { id: derived.id, explicit: false } : null
}, [nodes, edges])
```

---

### P2：`speakerName` 未 memoize，每次渲染重建 + 线性扫描

**位置**：`src/renderer/src/pages/HomePage.tsx:61-66`

**现象**：`speakerName` 函数定义在组件体内，每次渲染重建。每条带 speaker 的消息触发时对 `agentsQ.data` 和 `capabilitiesQ.data` 各做一次 `.find()` 线性扫描。

**建议修复**：与 P1 修复合并，用 `useMemo` 构建 `Map<string, string>`，O(1) 查找。

---

### P3：拓扑兜底将条件边 target 算作「有入边」

**位置**：`src/main/orchestrator/builder.ts:150`

```typescript
const hasIncoming = new Set(graph.edges.map((e) => e.target))
```

**现象**：`hasIncoming` 包含了条件边的 target。一个节点如果只有条件入边（条件不满足时不会被执行），在拓扑上仍可能是一个有效起点，但当前实现会把它排除出候选。

**评估**：MVP 阶段可接受。条件边作为入边意味着「可能从某处进入」，保守地排除是合理的。但建议在注释中说明这个决策。

---

### P3：多显式入口无 warn 日志

**位置**：`src/main/orchestrator/builder.ts:155`

**现象**：`resolveStartExecutor` 在多个节点 `isEntry === true` 时静默取 `explicit[0]`。虽然 `setEntryNode` 的单选语义保证了 UI 层面不会出现多入口，但数据层面（手动编辑 JSON、旧数据迁移）可能存在多个。

**建议**：加一行 warn 日志：

```typescript
if (explicit.length > 1) {
  logger.warn(
    `[builder] 多个显式入口（${explicit.map((n) => n.id).join(',')}），取 nodes 顺序首个`,
  )
}
```

---

### P3：`resolveStartExecutor` 未记录在设计文档中

**现象**：`resolveStartExecutor` 是当前未提交工作区的新增函数，设计依据只存在于代码 JSDoc 和测试中。`task.md`、`docs/REVIEW_SUMMARY.md`、`docs/REWRITE_PLAN.md` 均未提及入口解析算法。

**建议**：在 `task.md` 的 M4 编排保真部分补充入口解析的记录，或在 `docs/DESIGN.md` 中补充入口判定规则（显式优先 / 拓扑兜底 / sequential 递归）。

---

### P3：`setEntryNode(null)` 全量遍历可优化

**位置**：`src/renderer/src/pages/EditorPage.tsx:725-735`

**现象**：`setEntryNode(null)` 取消所有显式入口时，遍历所有节点写 `isEntry: false`。如果图很大且本来就没有显式入口，这是一次无意义的全量 `setNodes`。

**建议**：增加快速路径：

```typescript
const setEntryNode = useCallback((id: string | null) => {
  setNodes((nds) => {
    const hasAny = nds.some((n) => (n.data as { isEntry?: boolean }).isEntry)
    if (!hasAny && id === null) return nds
    return nds.map((n) => ({ ...n, data: { ...n.data, isEntry: n.id === id } }))
  })
}, [])
```

---

## 四、已确认正确的部分

以下改动经运行时验证，逻辑正确，无需修改：

| 改动 | 验证要点 |
|------|---------|
| `name: node.id`（铁律20修复） | runner `executors.get(node.id)` 能找到 executor，空白气泡修复 |
| `resolveStartExecutor` 容器递归 | sequential 不注册 executor，递归到首 participant；concurrent/groupchat/handoff 返回容器自身 |
| 前后端 `parentId` 一致性 | 前端用 `n.parentId`（ReactFlow 节点字段），后端用 `n.data.parentId`（序列化后），序列化代码 `EditorPage.tsx:747` 确认一致 |
| Inspector 单选语义 | `setEntryNode` 设入口时清除其它，避免旧多选 + stale isEntry 问题 |
| `findAgentNode` 仅用于 aggregator | participant 是画布节点（id 匹配），aggregator 可能引用角色库 id（需回退），当前覆盖正确 |
| `displayNodes` 对非入口节点返回原引用 | 不做 spread，ReactFlow diffing 可跳过未变更节点 |
| CSS 使用变量 | `.rf-entry-badge--derived` 用 `--color-bg-3` / `--color-fg-2` / `--color-brand-400`，符合硬约束 |
| i18n 完整 | 中英文齐全，`{{name}}` 模板变量正确 |
| 测试覆盖 | `builder-start.test.ts` 18 用例覆盖各类容器、嵌套、显式/隐式、边界 |

---

## 五、修复优先级

1. **P1 — speakerName 映射缺口**：直接影响能力图运行时的用户体验，气泡头部显示 `agent_ms76ai3a` 这样的无意义 id
2. **P2 — entryInfo memoize**：性能问题，`displayNodes` useMemo 形同虚设
3. **P2 — speakerName memoize**：性能问题，可与 P1 合并修复
4. **P3 项**：防御性改进，非阻塞
