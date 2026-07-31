# 代码审查问题清单

> 审查范围：最近 3 次 commit（`8a22ad1` ~ `93dbcfb`）
> 审查时间：2026-07-31
> 涉及文件：16 个（create.ts / home.ts / HomePage.tsx / CreateConfirmCard.tsx 等）
> 编译状态：通过 ｜ 测试状态：99 个全绿

---

## 严重程度说明

- **P0（严重）**：影响功能正确性，用户可感知的缺陷
- **P1（中等）**：不影响主流程，但存在隐患或体验问题
- **P2（轻微）**：代码整洁度、可维护性问题

---

## P0：HomePage 未处理 `orch_event` 事件

### 位置

`src/renderer/src/pages/HomePage.tsx` — `onStream` 回调（第 90~161 行）

### 现象

`HomeStreamEvent` 类型定义了 4 类事件来源：

```typescript
// src/shared/types.ts 第 203 行
export type HomeStreamEvent =
  | LlmDelta                                    // text / thinking / retry / error / message_stop ...
  | { type: 'run_id'; sessionId: string }       // 会话 id 通知
  | { type: 'orch_event'; event: StreamEvent }  // 编排引擎事件
  | { type: 'proposal'; draft: CreateDraft }    // 创建提案
```

后端 `runTeam` 确实在发 `orch_event`：

```typescript
// src/main/orchestrator/home.ts — runTeam
(e: StreamEvent) => onEvent({ type: 'orch_event', event: e })
```

但 HomePage 的 `onStream` 回调只处理了 6 种 delta：`thinking`、`text`、`retry`、`error`、`message_stop`、`proposal`。**没有 `orch_event` 分支，也没有 `run_id` 分支。**

### 影响

以下两条路径会触发编排引擎产出 `orch_event`：

1. **@提及直跳**：`@角色` / `@能力` → `directAgent` / `directCap` → `runTeam`（home.ts 第 240~266 行）
2. **LLM 意图路由判出组队**：`TeamJsonDetector.decide()` → `buildTeamGraph` → `runTeam`（home.ts 第 297~321 行）

编排引擎产出的所有事件（含 `output` 类型的 agent 文本流式输出）被**静默丢弃**。

用户在这些场景下的体验：
- 编排执行期间看不到任何流式文本
- 直到 `message_stop` 触发，前端从 `selectSession` 重载历史消息才能看到最终结果
- 多角色 groupchat 场景下完全无法看到中间 agent 的发言过程

### 建议修法

在 `onStream` 回调中补 `orch_event` 分支，至少处理 `event.type === 'output'` 把 `text` 追加到当前 AI 消息流：

```typescript
} else if (delta.type === 'orch_event') {
  const ev = delta.event
  if (ev.type === 'output') {
    // 编排 agent 产出文本 → 追加到末条 AI 消息
    setStreamMsgs((prev) => {
      const last = prev[prev.length - 1]
      if (last?.role === 'assistant' && last.streaming) {
        return [...prev.slice(0, -1), { ...last, text: last.text + ev.text }]
      }
      return [...prev, {
        id: crypto.randomUUID(),
        role: 'assistant' as const,
        text: ev.text,
        streaming: true,
      }]
    })
  }
  // node_started / node_done / handoff 等可选展示
}
```

`run_id` 分支可忽略（当前前端不依赖它，sessionId 由 `home:chat` 返回值同步）。

---

## P1：`TeamJsonDetector.flushDirect()` 含死代码三元

### 位置

`src/main/orchestrator/home.ts` 第 98~100 行

### 现状

```typescript
flushDirect(): string {
    return this.directBuffer + (this.teamStarted ? '' : '')
}
```

`this.teamStarted ? '' : ''` 两个分支都返回空字符串，三元完全等价于直接 `return this.directBuffer`。

### 影响

不影响正确性（逻辑等价），但代码意图不清晰——看起来像是想根据 `teamStarted` 做区分但没写完，容易误导后续维护者。

### 建议修法

```typescript
flushDirect(): string {
    return this.directBuffer
}
```

如果原意是「组队模式下不返回 directBuffer」，那应该改为：

```typescript
flushDirect(): string {
    return this.teamStarted ? '' : this.directBuffer
}
```

需确认原意后修正。

---

## P1：`pendingDrafts` 无清理机制

### 位置

`src/main/ipc/home.ts` 第 49 行

### 现状

```typescript
/** 创建提案草稿暂存（draftId → CreateDraft）；用户确认后取出落库并删除。 */
const pendingDrafts = new Map<string, CreateDraft>()
```

模块级 `Map`，仅在 `home:confirmCreate`（第 397 行）和 `home:cancelCreate`（第 405 行）时 `delete`。

### 影响

如果用户收到提案卡片后**既不点确认也不点取消**，直接关闭页面或切换会话，草稿永远留在内存中：
- 内存泄漏（长期运行积累）
- draftId 冲突概率极低但理论上存在

### 建议修法

方案 A（TTL 清理）：存入时记录时间戳，定期清理超时草稿（如 30 分钟）。

方案 B（会话切换清理）：在 `home:chat` 开始时清理与当前 `sessionId` 无关的旧草稿（需要 draft 上记录 sessionId）。

方案 A 更简单，推荐优先。

---

## P2：CSS 硬编码 fallback 色

### 位置

`src/renderer/src/styles/app.css` — `create-card` 相关样式（第 315~453 行新增段）

### 现状

多处使用带硬编码 fallback 的 CSS 变量：

```css
.create-card__badge--capability {
  background: color-mix(in oklch, var(--color-accent, #8b5cf6) 14%, transparent);
  color: var(--color-accent, #8b5cf6);
}

.create-card__badge--skill {
  background: color-mix(in oklch, var(--color-success, #10b981) 14%, transparent);
  color: var(--color-success, #10b981);
}

.create-card__input,
.create-card__textarea {
  border: 1px solid var(--color-border, color-mix(in oklch, var(--color-fg-3) 20%, transparent));
  background: color-mix(in oklch, var(--color-bg, #fff) 60%, transparent);
}
```

### 影响

项目铁律要求「所有颜色值必须使用 CSS 变量，不得硬编码 hex/rgb」。虽然这些是 fallback 值（变量未定义时才生效），但：
- `--color-accent` 和 `--color-success` 未在 `:root` 或任何 theme preset 中定义
- 三套主题（pure-white / warm / dark）下 fallback 值相同，无法随主题切换

### 建议修法

在 `src/renderer/src/styles/theme.css` 的 `:root` 或各 theme preset 中补齐 `--color-accent` 和 `--color-success` 定义，然后移除 CSS 中的 fallback 值：

```css
:root {
  --color-success: #10b981;
  --color-accent: #8b5cf6;
}
```

各 theme preset 按需覆盖。

---

## 审查通过项（无问题）

以下文件 / 逻辑审查后未发现问题，记录备查：

| 文件 | 审查结论 |
|------|----------|
| `src/main/tools/builtin/create.ts` | propose_* 工具经 `onPropose` 桥推草稿不落库，Zod 校验 graph 结构，逻辑正确 |
| `src/main/tools/builtin/create.test.ts` | 5 个测试覆盖正常路径 + 非法 graph 拦截 + 无桥降级，断言完整 |
| `src/main/orchestrator/home.ts` | 意图路由、@提及解析、skill 注入、组队图构建均与铁律对齐 |
| `src/main/orchestrator/home.test.ts` | 24 个测试覆盖 detector / mentions / skillBlocks / createInstruction |
| `src/main/orchestrator/agent.ts` | `toolCtx.onPropose` 透传到 `executeTool`，桥接完整 |
| `src/main/ipc/home.ts` | confirmCreate 以前端 payload 为准落库，kind 校验防篡改 |
| `src/renderer/src/components/CreateConfirmCard.tsx` | 字段可编辑、状态流转（pending→saved/cancelled）正确 |
| `src/renderer/src/components/MentionComposer.tsx` | @提及芯片序列化、分组下拉、近期优先排序正确 |
| `src/preload/index.ts` | `confirmCreate` / `cancelCreate` API 注册完整 |
| `src/main/tools/registry.ts` | `ToolContext.onPropose` 类型定义完整 |
| `src/main/index.ts` | `registerCreateTools()` 在 app ready 后注册 |

---

## 修复优先级建议

1. **先修 P0**（`orch_event` 缺失）—— 直接影响编排场景的用户体验
2. **再修 P1**（pendingDrafts 清理）—— 防止长期内存泄漏
3. **P1 死代码** 和 **P2 CSS** 可在下一次清理时一并处理
