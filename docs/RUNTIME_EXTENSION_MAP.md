# One 运行时扩展点地图（RUNTIME_EXTENSION_MAP）

> 配套 [`PLUGIN_ARCHITECTURE.md`](./PLUGIN_ARCHITECTURE.md) §4。「我想加 X 该挂哪」——按问题组织，不是按目录组织。
> 每条给：**推荐入口 / ⚠️不推荐入口 / 原因**。**规则**：每次改造某个挂点（P0–P3），顺手补一条，文档跟改造长，不后端回溯。
> 统一插件契约见 `src/main/plugins/contracts.ts`（`OnePluginManifest` / `PluginHost` / `PluginLifecycle`）；运行时事实总线见 `src/main/plugins/events.ts`。

| 我想…… | 推荐入口 | ⚠️ 不推荐入口 | 原因 |
|---|---|---|---|
| 加一个给 LLM 的新工具能力 | `tools/registry.ts` 的 `registerTool(...)` + 在 `tools/builtin/` 加模块；外部服务走 `tools/mcp/` | 塞进 `ipc/home.ts` 或 `orchestrator/runner.ts` | 工具只有注册进 registry 才会进 `listAgentToolDefs` 进 LLM 可见 dict；放进编排层会破坏「Agent ≠ tool-use 循环」铁律 |
| 加一个会话级策略 / preCheck / approval 规则 | `registerTool` 的 `options.preCheck`，或 `registry.ts` 的 approval 闸门 + `sessionApprovals` | 写进 handler 内部 if 分支 | 闸门序列（preCheck → 审批 → 重试）统一；散落 handler 会被绕开 |
| **在聊天里现场让 AI/用户造一个新工具，造完立刻能用** | 走 `generated` kind 的 **A 声明式 AI 工具**：`name/description/zod schema` + 一个只读/检索白名单动作声明 → `PluginHost.tools.register` 运行时注册（白名单在**注册点** fail-closed，非白名单直接拒注册）+ 持久化 manifest；需新逻辑再升层 B | 让 AI 直接改 `src/main/tools/builtin/*.ts` 源码后热重载 | 声明式 A 只需描述参数并判发**只读/检索白名单动作**，白名单在注册点 fail-closed、动作继承既有围栏，零新增执行面；改源码把「工具加入」绑死编译期，无法现场生效，且攻击面更大；B 代码型严格 fail-closed |
| 加一个 skill 运行时行为（注入 / 校验 / 审计） | 扩展 `skills/provider.ts` 的 `SkillContextProvider`，或订阅 `PluginHost.events` | `beforeRun` 里硬编码深层逻辑 | Skill 现在只做 instructions 注入 + afterRun 审计，hook 应保持注入器职责。**当前真实签名**：`beforeRun({ agentName, skillIds, instructions })` / `afterRun(): void`（无 session/context/state）；要接事件总线/per-agent 状态，经构造参数注入的 `this.host` 访问（`beforeRun`/`afterRun` 签名不变，见 PLUGIN_ARCHITECTURE.md §3「注入方式定死」） |
| 加一个外部工具服务 | `tools/mcp/` 配置 + adapter | 自己裸连 `registerTool` | MCP 提供生存期 disconnection 清理、命名空间（`mcp__{serverId}__`）、approval 默认值兜底 |
| 加一个按能力域的「子能力卸载」 | `unregisterByPrefix(pluginName+span)` 回滚 | 在 runtime 里强删 registry | 前缀是所有权边界，回滚防孤儿名 |
| 加一个运行事实 / 诊断点 | `run_events` 体系（持久化事实，`storage/runEvents`）+ `PluginHost.events`（App 内实时总线） | `logger` 打个 `console` | 持久化事实才能回放；`run_events` **已落地**（`storage/runEvents.ts` + `db.ts` `run_events` 表 + orchestrator/scheduler/ipc 全链路写盘）；`PluginHost.events` 是其上的轻量实时投影，**不重复建持久层** |
| 给插件加「配置项 / 启停开关 / 密钥引用 / 设置页」 | manifest 里 `configSchema` + 现有 settings/vault IPC（密钥按 `vault.getKey(keyId)` 引用，入主进程不落渲染层） | 让插件自己直连存储/环境变量读密钥 | 配置与密钥都是**声明式资源**，走既有设置与 vault 才符合铁律——插件只声明、框架提供存取 |

## 挂点速查（代码事实锚点）

- **工具注册表**：`src/main/tools/registry.ts`（`registerTool` / `unregisterByPrefix` / `listToolDefs` / `listAgentToolDefs`）。`RegisteredTool` 仅含 `def/handler/zodSchema`，无来源/owner 字段——所有权隐含在命名前缀（`mcp__{serverId}__`）。
- **插件宿主**：`src/main/plugins/host.ts`（`pluginHost` 单例，包 `tools` 只读代理 + `events` 总线）。Skill 经**构造参数**注入 `host`（不走 `onLoad`），见 PLUGIN_ARCHITECTURE.md §3。
- **Skill 注入**：`src/main/skills/provider.ts`（`SkillContextProvider.beforeRun` / `afterRun`；`afterRun` 经 `this.host.events.emit('skill.injected', ...)` 投影运行事实）。
- **运行事实持久层**：`src/main/storage/runEvents.ts` + `db.ts` 的 `run_events` 表；写盘点遍布 `registry.executeTool` / `orchestrator` / `scheduler` / `ipc`。
- **密钥**：`src/main/secrets/vault.ts`（`getKey(keyId)` 解密；密钥只存引用，不明文落盘）。
- **扩展点地图本文件**：P0–P3 每改一个挂点，补一行到这里，跟改造长。
