# Agent 智能基座 — 代码评审问题清单

> 评审对象：`2026-08-10-single-agent-coding-substrate` 计划对应的已提交代码（6 个 commit，覆盖 Task 0/1/2/3/4/5/6/7/8a/8b/9）。
> 评审方式：对照计划文档与源码逐条核实，所有结论均基于代码事实，非疑似。
> 评审日期：2026-08-10

## 评审结论概览

| 编号 | 严重度 | 位置 | 问题 | 状态 |
|---|---|---|---|---|
| C1 | Critical | `patterns/agent.ts` | hasTools 分支产出孤儿 tool_result，破坏 tool 配对 | 已修复（重建真 tool_use block） |
| I1 | Important | `grep.ts` | glob 用绝对路径匹配，传 glob 几乎过滤掉全部文件 | 已修复 |
| I2 | Important | `strReplace.ts` | `text.replace()` 替换串含 `$` 被特殊展开，静默损坏代码 | 已修复 |
| I3 | Important | `home.ts` | 组队节点 toolCtx 缺 `onPlanUpdate` 桥，行为不一致 | 已修复 |

---

## Critical

### C1. hasTools 分支产出"孤儿 tool_result 块"，破坏 tool_use/tool_result 配对 ✅ 已修复

- **文件：** `src/main/orchestrator/patterns/agent.ts:132-136`
- **问题：** `assembleMessages` 在 `hasTools` 时，只有 `isFunctionResult` 的消息被转成 `{ type: 'tool_result', tool_use_id }` 块（132-133 行）；对应的 tool_use 占位消息（`role: 'assistant'`, `toolUseId` set, `isFunctionResult` falsy）走 else 分支变成**纯文本** `[tool:grep]`（136 行），`toolUseId` 被丢弃。
- **结果：** 组装出的消息里存在 `tool_result` block，但整轮消息中**没有任何 `tool_use` block** 与之配对。
- **为何严重：** 项目自身 `repairToolPairs`（`constraints.ts`）注释明确为治 Anthropic 2013 孤儿 tool 校验而设。带 tools 的 AgentExecutor（`orchestrate.ts` / `home.ts` 节点均注入 `tools: nodeTools`）第二次 handle 重组 cache 时，会把上一轮自己写入的 tool_result 单独变成块、tool_use 变成文本 → 触发 2013/400。这正是计划要治的"多 agent 失忆 + 带工具链路"目标场景。
- **为何没被测试抓到：** `patterns/agent.test.ts:181-206` 只断言"存在 tool_result block"，不校验是否存在对应 tool_use block。
- **修复：** 2026-08-10 两阶段修复。
  - 阶段 1（全文本路线）：hasTools 分支不再转 tool_result 为 block，全部走文本，避免孤儿 tool_result。补了配对断言。
  - 阶段 2（重建真 block，方案见 `docs/c1-tool-use-block-rebuild.md`）：`OrchMessage` 加 `toolUseName`/`toolUseInput` 字段；`onToolCall` 写 cache 时存 name + input；`assembleMessages` hasTools 分支重建真 `{ type: 'tool_use', id, name, input }` block，与 `tool_result` block 完整配对。`repairToolPairs` 在重建之前调用，孤儿 tool_use 先降级为纯文本（删 toolUseId），不会进入重建分支。测试断言"每个 tool_result 的 tool_use_id 必须有配对的 tool_use block"。
- **验证：** `npm test` 452 个全绿（含 C1 重建真 block 强断言 + 并行乱序配对回归）；`npm run typecheck` 干净。

---

## Important

### I1. grep 的 glob 过滤匹配错对象（绝对路径 vs 相对路径） ✅ 已修复

- **文件：** `src/main/tools/builtin/grep.ts:48-56,89`
- **问题：** `walkFiles` 产出的是**绝对路径**（`full = join(absDir, e.name)`，`absDir` 来自 `resolve(ctx.workspaceRoot, ...)`）。89 行 `if (input.glob && !matchesGlob(file, input.glob))` 传 `file` 绝对路径给 `matchesGlob`，而 `matchesGlob` 把 glob `*.ts` 编译成 `^[^/]*\.ts$`，对 `/abs/path/a.ts` 必然不匹配。
- **结果：** 传 glob 时几乎过滤掉全部文件，返回空结果，误导 LLM。
- **为何没被测试抓到：** `grep.test.ts:44` `data.matches.every((m) => m.path.endsWith('.ts'))` 在 matches 为空数组时**空真通过**。
- **修复：** 2026-08-10 已修复——改为 `relative(ctx.workspaceRoot, file)` 再匹配；测试补"过滤后结果非空且只含 .ts"的真断言。

### I2. str_replace 用 `text.replace()`，`new_str` 含 `$` 被特殊展开 ✅ 已修复

- **文件：** `src/main/tools/builtin/strReplace.ts:107`
- **问题：** `const next = text.replace(input.old_str, input.new_str)`。JS `String.replace` 的替换串会对 `$&` / `$$` / `` $` `` / `$'` 做特殊展开。LLM 插入含 `$` 的代码（shell `$1` / `$$`、字符串字面量）会被**静默改写且无报错**。
- **结果：** 行级编辑工具静默损坏用户代码，难以发现。
- **修复：** 2026-08-10 已修复——改用 `slice` 拼接（`text.slice(0, idx) + new_str + text.slice(idx + old_str.length)`），保持 LLM 插入的代码原样；补了含 `$&` / `$1` 的替换测试。

### I3. home 组队节点 toolCtx 缺 `onPlanUpdate` 桥 ✅ 已修复

- **文件：** `src/main/ipc/home.ts:509-554`（组队/能力节点 toolCtx）
- **问题：** 主 agent（`home.ts:437-447`）和 orchestrate 的 `resolveAgent` 都注入了 `onPlanUpdate`（→ `emitStream({ type: 'orch_event', event: { type: 'plan_update' }})`）；但首页组队/能力节点（509-554 行）的 toolCtx 只有 `sessionId / workspaceRoot / signal / onAskUser / onApprove`，**没有 onPlanUpdate**。
- **结果：** 首页触发组队图时 `update_plan` 工具照常执行，但计划进度不推前端，与 Editor 编排行为不一致。
- **修复：** 2026-08-10 已修复——在组队/能力节点 toolCtx 补 `onPlanUpdate`（emitStream 包 `orch_event`，与主 agent 同款）。

---

## 经核实不构成 bug 的疑似项（澄清）

| 编号 | 疑似项 | 核实结论 |
|---|---|---|
| M1 | glob 尾段 `**` 匹配不到（`glob.ts`） | **非 bug**：`**` → `.*` 后 `^src/.*$` 对 `src/a.ts` 可匹配（`.*` 允许空串）。仅纯 `**`（`^.*$`）有语义疑问，非功能缺陷 |
| M2 | str_replace 错误码与计划不一致（`no_match`/`multiple_match` vs 计划 `old_str_not_found`/`old_str_not_unique`） | 功能可用，与计划命名偏离；测试按实现写，非正确性 bug |
| M3 | runner 每次 deliver O(n) 全量算 token（`runner.ts`） | 性能问题，非正确性 bug，MVP 可接受 |
| M4 | 无 Electron 时 `getUserDataDir()` 回退固定 tmp 路径（`paths.ts`） | 多进程测试场景假设，非当前缺陷 |

---

## 建议

1. **优先修 C1**：决定 hasTools 路径下 tool 轨迹的表示（全文本 或 重建真 tool_use 块），并补"tool_result 的 id 必须存在匹配 tool_use 块"的断言。
2. **修 grep glob（I1）** 并加固测试为真断言；顺带统一 grep / glob 的相对路径匹配。
3. **str_replace 换 slice 拼接（I2）**，补含 `$` 的替换测试。
4. **统一 home 组队节点 onPlanUpdate（I3）**。

**合并结论：✅ 已修复，可合并**——四项问题均已修复并验证：C1 孤儿 tool_result 改全文本形态避免配对断裂；I1 grep glob 改相对路径匹配 + 真断言；I2 str_replace 改 slice 拼接防 `$` 展开；I3 home 组队节点补 onPlanUpdate 桥。`npm test` 451 个全绿，`npm run typecheck` 无错，`npm run build` 成功。