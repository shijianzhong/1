# C1 修复方案 — 重建真 tool_use block（治孤儿 tool_result）

> 关联评审：`docs/agent-substrate-review.md` C1
> 关联代码：`src/main/orchestrator/patterns/agent.ts` + `src/shared/types.ts`
> 日期：2026-08-10

## 问题回顾

`assembleMessages`（`patterns/agent.ts:122-154`）的 `hasTools` 分支：

- `isFunctionResult` 的消息 → 转成 `{ type: 'tool_result', tool_use_id }` block ✅
- tool_use 占位消息（`toolUseId` set, `isFunctionResult` falsy）→ 走 `else` → 纯文本 `[tool:grep]`，**toolUseId 被丢弃，没有产出 `tool_use` block** ❌

结果：组装出的消息里有 `tool_result` block，但**没有配对的 `tool_use` block** → Anthropic 2013（孤儿 tool_result）。

当前临时修法（全文本路线）：`hasTools` 时 tool_result 也降为文本，不转 block。这治了 2013，但**放弃了 Anthropic 原生 tool_use/tool_result 配对语义**——下游 agent 只能看文本，拿不到结构化的工具调用信息。项目已过 MVP 阶段，需稳固合理，故须重建真 block。

## 根因

不在 `assembleMessages`，在更上游：

**`OrchMessage.content` 是 `string`**（`shared/types.ts:177`）。Task 8a 的 `onToolCall` 写 cache 时只存了占位文本 `[tool:grep]`，**丢了 tool_use 的 `name` 和 `input`**。所以 `assembleMessages` 想重建 `tool_use` block 也无米之炊——`LlmContentBlock` 的 `tool_use` 变体要求 `{ id, name, input }`，cache 里只有 id 和占位文本。

```
Agent.run onToolCall(tool, _args, toolUseId)
    ↓
cache.push({ content: '[tool:grep]', toolUseId })   ← 丢了 name/input
    ↓
assembleMessages: hasTools 分支
  tool_result → 真 block ✅（有 tool_use_id + content）
  tool_use 占位 → 只能走文本 ❌（没有 name/input，无法重建 block）
```

## 修复方案

四步，改 `OrchMessage` 类型 + `onToolCall` + `assembleMessages` + 测试。不碰 runner / constraints / 五模式。

### Step 1: OrchMessage 加 tool_use 元数据字段

`src/shared/types.ts:174-184`：

```ts
export interface OrchMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  author?: string
  content: string
  toolUseId?: string
  isFunctionResult?: boolean
  shouldRespond?: boolean
  /** C1：tool_use 占位时存工具名，assembleMessages 据此重建真 tool_use block */
  toolUseName?: string
  /** C1：tool_use 占位时存入参，assembleMessages 据此重建真 tool_use block */
  toolUseInput?: unknown
}
```

> 两个字段都可选，不破坏既有 OrchMessage 构造点（无-tools 路径不填这两个字段，行为不变）。

### Step 2: onToolCall 写 cache 时存 name + input

`src/main/orchestrator/patterns/agent.ts:73-80`（Task 8a 的 callbacks）：

```ts
onToolCall: (tool, _args, toolUseId) => {
  this.cache.push({
    role: 'assistant',
    author: this.id,
    content: `[tool:${tool}]`,   // 占位文本仍保留（无-tools 下游降级时用）
    toolUseId,
    toolUseName: tool,            // ← 新增
    toolUseInput: _args,          // ← 新增
  })
},
```

> `onToolResult` 不变——它写 `{ role:'user', content: result, toolUseId, isFunctionResult: true }`，已经够 assembleMessages 转 tool_result block。

### Step 3: assembleMessages hasTools 分支重建真 tool_use block

`src/main/orchestrator/patterns/agent.ts:128-136`，替换当前的"全文本"逻辑：

```ts
const messages: LlmMessage[] = []
for (const m of source) {
  const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user'
  let content: LlmMessage['content']
  if (hasTools && m.isFunctionResult) {
    // tool_result → 真 block（配对用 tool_use_id）
    content = [{ type: 'tool_result', tool_use_id: m.toolUseId ?? '', content: m.content }]
  } else if (hasTools && m.toolUseId && m.toolUseName) {
    // C1 修复：tool_use 占位 → 重建真 tool_use block（配对完整，不再孤儿）
    content = [{ type: 'tool_use', id: m.toolUseId, name: m.toolUseName, input: m.toolUseInput ?? {} }]
  } else {
    content = m.content
  }
  // 同角色合并逻辑不变（138-154 行原样保留）
  ...
}
```

> 关键：tool_use block 的 `id` 和 tool_result block 的 `tool_use_id` 必须相同（都来自 `m.toolUseId`），Anthropic 据此配对。

### Step 4: 无-tools 下游行为不变（确认，无需改）

`stripToolBlocksFilter`（`constraints.ts:59-61`）：

```ts
return messages.filter((m) => m.role !== 'tool' && !m.isFunctionResult)
```

- 剥 `isFunctionResult`（tool_result）—— ✅ 仍剥
- tool_use 占位（`role:'assistant'`, `toolUseId` set, `isFunctionResult` falsy）—— **保留**（role 不是 'tool'，isFunctionResult falsy）

无-tools 下游仍收到 `[tool:grep]` 占位文本，知道上游调了什么工具，但不会被 tool_result block 污染（已被剥）。行为与当前一致，无需改。

### Step 5: 测试改强断言

`src/main/orchestrator/patterns/agent.test.ts` Task 8b 的"有 tools"测试：

```ts
it('有 tools 时重建真 tool_use/tool_result 配对（无孤儿 block）', async () => {
  // ... 预置 cache（含 toolUseName/toolUseInput）
  ex.cache.push({ role: 'assistant', author: 'cap', content: '[tool:grep]', toolUseId: 'tu_1', toolUseName: 'grep', toolUseInput: { pattern: 'foo' } })
  ex.cache.push({ role: 'user', content: '结果', toolUseId: 'tu_1', isFunctionResult: true })
  // ... drain

  // 强断言：每个 tool_result 的 tool_use_id 必须有配对的 tool_use block
  const toolResultBlocks = (captured.messages ?? []).flatMap((m) =>
    Array.isArray(m.content)
      ? (m.content as Array<{ type: string; tool_use_id?: string }>).filter((b) => b.type === 'tool_result')
      : [],
  )
  const toolUseIds = (captured.messages ?? []).flatMap((m) =>
    Array.isArray(m.content)
      ? (m.content as Array<{ type: string; id?: string }>).filter((b) => b.type === 'tool_use').map((b) => b.id)
      : [],
  )
  for (const b of toolResultBlocks) {
    expect(toolUseIds).toContain(b.tool_use_id)  // 每个 result 必有配对 use
  }
  // 确认产出了真 tool_use block（非全文本）
  expect(toolUseIds).toContain('tu_1')
})
```

## 影响范围

| 文件 | 改动 | 风险 |
|---|---|---|
| `src/shared/types.ts` | OrchMessage 加 2 可选字段 | 零（可选，不破坏既有构造点） |
| `src/main/orchestrator/patterns/agent.ts` | onToolCall 存 name/input + assembleMessages 重建 block | 低（只改 hasTools 分支，无-tools 路径走 strip 不变） |
| `src/main/orchestrator/patterns/agent.test.ts` | 强断言 | 零 |
| `src/main/orchestrator/constraints.ts` | **不改** | strip 逻辑不变 |
| `src/main/orchestrator/runner.ts` | **不改** | 不碰 Pregel |
| `src/main/orchestrator/agent.ts` | **不改** | Agent.run 的 onToolCall 签名已含 toolUseId（Task 8a） |

## 为什么这个修法是稳固的

1. **治 2013**：tool_use 和 tool_result 都是真 block，id 配对完整，Anthropic 校验通过。
2. **保留原生语义**：下游 agent 拿到结构化 `{ type:'tool_use', name, input }` + `{ type:'tool_result', tool_use_id, content }`，比文本更精确——能知道上游调了什么工具、传了什么参数、返回了什么。
3. **不破无-tools 下游**：strip 仍剥 tool_result，tool_use 占位仍降级为文本（`[tool:grep]`），行为与当前一致。
4. **不碰编排内核**：只改 OrchMessage 类型 + agent executor 两点。runner 的 superstep 执行、constraints 的 strip/repair、五模式语义都不动。
5. **与 repairToolPairs 兼容**：`repairToolPairs`（`constraints.ts:21-52`）按 toolUseId 集合匹配孤儿 tool_use/tool_result 降级。重建后配对完整，repairToolPairs 不会触发降级（没有孤儿），行为正确。

## 并行乱序兼容性（Task 4 交互）

Task 4 并行后，cache 物理顺序可能乱序（`tool_use_A → tool_use_B → result_B → result_A`）。本修复不受影响：

- `repairToolPairs` 按 toolUseId 集合匹配（非位置依赖），乱序也能配对。
- `assembleMessages` 重建 block 时用 `m.toolUseId` 做 id，与位置无关。
- 同角色合并时，乱序的 result_B + result_A 会被合并为同一条 user 消息的两个 tool_result block——这是正确行为（Anthropic 允许一条 user 消息含多个 tool_result block）。

## 验收点

- [ ] `assembleMessages` hasTools 分支产出真 `tool_use` block（含 id/name/input）
- [ ] 每个 `tool_result` block 的 `tool_use_id` 在组装结果里有配对的 `tool_use` block
- [ ] 无-tools 下游仍走 stripToolBlocksFilter，tool_use 占位降级为文本
- [ ] `npm test` 全绿（含新强断言 + 既有乱序配对测试）
- [ ] `npm run typecheck` 干净
