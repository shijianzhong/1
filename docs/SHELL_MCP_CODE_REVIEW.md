# Shell + MCP 代码评审

> **范围**：P0 审批闸门、P1 `shell_run`、P2 MCP client / 搜索后端 / 设置页  
> **对照**：`shell-mcp-plan/shell-mcp-plan.html`（v2）+ `CLAUDE.md` 铁律  
> **Git 区间**：`2ebaa80^` … `HEAD`（含 `2ebaa80` / `5cabec1` / `48b33bd` / `c4dba43` / `dc7666e` 等）  
> **日期**：2026-08-05  
> **结论**：P0/P1 扎实可合；P2 有 Critical/Important 项，建议修完再当「完成」

---

## 1. 总评

| 维度 | 评价 |
|------|------|
| P0 `approvalMode` 闸门 | ✅ 已在 `executeTool` 真实接线，非空壳 |
| P1 `shell_run` | ✅ 对齐 opencli spawn 纪律 + `always` + preCheck |
| HITL UI / home 桥 | ✅ `onApprove` 首页与编排均已注入 |
| P2 MCP 骨架 | ✅ stdio + Streamable HTTP / AJV / 原子配置 / IPC |
| P2 生产完备度 | ⚠️ 工具全量暴露、断连注销、密钥存储仍有缺口 |
| 单测 | ✅ `src/main/tools` 相关用例通过 |

**Ready to merge?** With fixes —— shell/审批可先合；把 MCP 当生产完成前，至少处理 Critical + Important §3.1–3.2。

---

## 2. 做得好的地方

1. **P0 闸门是真的**  
   `registry.ts` 中 `executeTool` 顺序为：Zod → `preCheck` → `approvalMode === 'always'` → `onApprove` → handler。缺桥返回 `approval_unavailable`；拒绝 / 300s 超时均结构化 JSON（铁律 11）。

2. **`shell_run` 无法绕过闸门**  
   注册为 `'always'`；DANGER 走审批前 `preCheck`；无 `onApprove` 时 handler 不执行。`shell.test.ts` / `registry.test.ts` 覆盖 deny / unavailable / danger。

3. **HITL 端到端**  
   - 主进程：`home.ts`、`orchestrate.ts` 注入 `onApprove`（含 commit `dc7666e`）  
   - 渲染：`ApprovalCard` → `orchestrate:respond`；reducer 处理 `approval_request` / `approval_resolved`

4. **spawn 纪律对齐 opencli**  
   自建 timer + 进程组 SIGKILL、stdout 上限、AbortSignal、`messageKey`、不用 Node `spawn` 的伪 `timeout` 选项；env 对 `*_KEY` / `*_SECRET` / `*_TOKEN` 粗过滤。

5. **MCP 栈整体连贯**  
   stdio + Streamable HTTP；AJV + `inputSchemaOverride`；默认 `approvalMode: 'always'`；显式 disconnect/remove/update 路径会 `unregisterByPrefix`；配置 JSON + `writeJsonAtomic`；IPC `withHandler` + preload 白名单。

6. **搜索后端**  
   `web.ts` 优先级 Brave → Jina → Bing HTML，比纯爬 Bing 有实质改进。

---

## 3. Issues

### 3.1 Critical（Must Fix）

#### C1. 首页 / 编排 `listToolDefs()` 全量暴露（含全部 MCP）

- **位置**：`src/main/ipc/home.ts`（约 L214、L315）、`src/main/ipc/orchestrate.ts`（约 L131）  
- **问题**：方案 v2 要求按 server 开关或 agent 白名单裁剪；当前把 registry 全量塞进主助手与图节点 agent。  
- **为何严重**：  
  - Context 膨胀；  
  - UI（`McpSettings.tsx`）允许把 server 设为 `approvalMode: 'auto'`，写类 / filesystem MCP 可零 HITL 执行。  
- **修法**：  
  - 首页：builtin 白名单（memory / web / propose / ask_user / shell / file / opencli / skill_run_script 等）；  
  - MCP：仅显式绑定或「启用并勾选注入主助手」时注入；  
  - 禁用 / 断开时继续 `unregisterByPrefix`。

---

### 3.2 Important（Should Fix）

#### I1. 意外断连不注销工具

- **位置**：`src/main/tools/mcp/client.ts`（`transport.onclose`，约 L48–52）  
- **问题**：只从 `clients` Map 删除，未调用 `unregisterMcpTools`。  
- **影响**：`listToolDefs()` 仍含死掉的 `mcp__*`；LLM 继续调用直到失败。  
- **修法**：`onclose` 与 IPC disconnect 共用 teardown：`unregisterMcpTools(id)` → `clients.delete`。

#### I2. `mcp:connectServer` 重连未先注销

- **位置**：`src/main/ipc/mcp.ts`（约 L88–96）；对比 `updateServer` / `disconnectServer` 路径  
- **问题**：`connectServer()` 内部只 `disconnectServer`（不断注册表）；随后 `registerMcpTools` 遇 `hasTool` 会 skip → 返回 `{ toolCount: 0 }`，状态与 registry 不一致。  
- **修法**：connect 前始终 `unregisterMcpTools(id)`（与 update/remove/disconnect 对齐）。

#### I3. MCP 密钥未走 vault

- **位置**：`src/main/tools/mcp/config.ts`；`mcp:listServers` 回传完整 `config`  
- **问题**：`env` / `headers` 可含 API key，明文落 `userData` JSON，并进入渲染进程（铁律 3 / 方案 v2）。  
- **修法**：敏感字段 vault 引用；list IPC 脱敏；UI 未编辑 env 前也勿整包回传明文。

#### I4. 审批通过后仍自动重试 handler

- **位置**：`src/main/tools/registry.ts`（约 L178–196）  
- **问题**：`always` 工具用户点允许后，handler throw 仍按 500/1000/1500ms 重试最多 4 次。  
- **影响**：`shell_run` / 写类 MCP 可能部分执行后再次执行。  
- **修法**：`approvalMode === 'always'`（或非幂等标记）跳过重试；工具侧优先返回错误 JSON 而非 throw。

#### I5. `task.md` 与实现不一致

- **位置**：`task.md` 约 L151  
- **问题**：仍写「shell/browser_use 未做」，但 `shell_run` + P0 已落地；7.2 已勾 ✅。  
- **修法**：增加 `[x] 7.1 shell_run + P0 approval…`；browser_use 保持未勾。

---

### 3.3 Minor（Nice to Have）

| # | 说明 | 位置 |
|---|------|------|
| M1 | 无 key 时仍降级 Bing HTML；可改为默认失败 + 显式 opt-in | `web.ts` |
| M2 | 注释写「SSE fallback」，实现仅 Streamable HTTP | `client.ts` L9 |
| M3 | `ToolApprovalMode` 含 `'never'`，`executeTool` 未实现（等同 auto） | `registry.ts` |
| M4 | orchestra reducer 缺 `approval_*` 单测（ask_user 有覆盖） | `reducer` / tests |
| M5 | env scrub 仅后缀 `_KEY/_SECRET/_TOKEN`，漏如 `AWS_ACCESS_KEY_ID` | `shell.ts` |
| M6 | `home.ts` 中 `toolCtx` 闭包早于 `AbortController` 声明（运行时尚可，脆弱） | `home.ts` |

---

## 4. 与方案 v2 对照

| 方案要求 | 实现状态 |
|----------|----------|
| P0：`executeTool` 接线 `always` | ✅ |
| 禁止无审批 shell 合入 | ✅ |
| P1：async spawn + messageKey + DANGER 辅助 | ✅ |
| P2：stdio + Streamable HTTP、AJV、原子配置 | ✅ |
| P2：工具列表裁剪 | ❌（C1） |
| P2：断连 / 重连 registry 一致 | ⚠️（I1、I2） |
| P2：vault 存 MCP 密钥 | ❌（I3） |
| 搜索换 API（Brave/Jina） | ✅（Bing 仍为最后 fallback） |
| Agent-Reach 可选、不绑完成定义 | ✅（未绑死） |

---

## 5. 建议修复顺序

1. **C1** 工具列表裁剪（首页白名单 + MCP 显式注入）  
2. **I1 + I2** MCP teardown 统一：`unregister → disconnect`（含 `onclose` / reconnect）  
3. **I4** `always` 工具关闭自动重试  
4. **I5** 同步 `task.md`  
5. **I3** 暴露 env/headers UI 前接 vault + 脱敏 IPC  
6. Minor 按需

---

## 6. 关键文件索引

| 区域 | 路径 |
|------|------|
| 审批闸门 | `src/main/tools/registry.ts` |
| shell | `src/main/tools/builtin/shell.ts`、`shell.test.ts` |
| 搜索 | `src/main/tools/builtin/web.ts` |
| MCP | `src/main/tools/mcp/{client,adapter,config,index}.ts` |
| MCP IPC | `src/main/ipc/mcp.ts` |
| HITL 注入 | `src/main/ipc/home.ts`、`orchestrate.ts` |
| 审批 UI | `src/renderer/src/components/orchestra/ApprovalCard.tsx` |
| MCP UI | `src/renderer/src/components/McpSettings.tsx`、`pages/McpPage.tsx` |
| 方案 | `shell-mcp-plan/shell-mcp-plan.html` |
| 进度 | `task.md` §阶段 7 |

---

## 7. Assessment

**Ready to merge?** With fixes

**Reasoning：** P0/P1 安全底座（闸门 + shell + home/orchestrate `onApprove` + ApprovalCard）与单测质量足够合入。P2 在「MCP 工具全量进主助手」「意外断连/重连 registry 不一致」「密钥未 vault」修好之前，不宜标为生产完成。
