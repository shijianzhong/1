# One 项目架构评审与迭代建议

> 时间：2026-08-07（同日按源码复核修订）  
> 范围：当前仓库源码 + `task.md` + `CLAUDE.md`  
> 校验：`npm test` 通过（46 个测试文件 / 391 个测试）  
> 原则：下列风险与路径描述以**代码事实**为准；行号为复核时快照，优先按符号定位。

---

## 一、结论摘要

整体判断：**当前项目的大架构是合理的**。

`main / preload / renderer / shared` 分层清楚，Electron 安全边界、IPC 错误收口、SQLite/vault、编排引擎、Registry、Skill ContextProvider 这些基础模块都已经成型。项目已经不是“功能堆起来”的状态，而是有明确边界和演进方向的桌面 Agent 平台。

但如果聚焦到“**主 Agent 自由召唤资产**”这个目标，当前状态更准确的表述是：

- **单资产可用**
- **混合资产部分可用**
- **还不算完整完成版**

也就是说，平台地基已经立住，但“资产如何被发现、引用、组合、授权、恢复”这一层还没有完全产品化。

---

## 二、当前架构合理性

### 2.1 分层是健康的

- `src/main/` 承担桌面后端、编排、工具、存储、Registry、MCP
- `src/preload/` 作为唯一能力桥接层
- `src/renderer/` 只消费 `window.one.*`
- `src/shared/types.ts` 作为主/渲染统一契约源

这套分层对 Electron 桌面应用来说是正确的，没有把业务逻辑散落在 preload 或 renderer。

### 2.2 编排内核方向正确

- 采用 Pregel superstep 模型，而不是简单拓扑排序
- Sequential / Concurrent / GroupChat / Handoff 都已经落地
- GroupChat 的 cache / dedup / fairness / manager_output patch 已接入运行时
- `Agent` 本身只管上下文与 tool-use 循环，没有把太多工作塞进单点类

这说明项目最核心的“多 Agent 协作执行内核”设计方向是对的。

### 2.3 资产体系已经模块化了一半

- Skill 已经收口为 `ContextProvider`
- Registry 已经拆成 `service / importer / exporter / ipc`
- MCP 有独立配置、连接、adapter、暴露策略

这些都说明资产体系不是写死在聊天页里的，而是朝平台模块走的。

---

## 三、主要风险点

## 3.1 主 Agent 自由召唤资产仍不完全保真

### 风险 1：角色 + 能力混合召唤（2026-08-08：真子图已接入）

证据：`buildTeamGraph` / `embedCapabilityGraph`（[`src/main/orchestrator/home.ts`](file:///Users/shijianzhong/sking/one/src/main/orchestrator/home.ts)）

当前规则：

- 仅单能力：返回真实 `graph`
- 仅单角色：单 agent 图；多角色无能力：groupchat
- **多能力 / 角色+能力**：外层 `sequential`，能力经 `embedCapabilityGraph` 前缀嵌入真实子图，再接角色段

残留：复杂嵌套图的边界边 / 多入口能力仍依赖 `resolveStartExecutor` + `resolveSeqBoundary`；需继续用真实能力图回归。

> 纯 `@单能力` 提及仍走 `focusCap`（不直跳），见 §五。

### 风险 2：@召唤协议（2026-08-08：稳定 token 已接入）

证据：

- 共享协议：[`shared/mentions.ts`](file:///Users/shijianzhong/sking/one/src/shared/mentions.ts)（`@[agent|capability|skill:<id>]`）
- 前端芯片序列化为 token：[`MentionComposer.tsx`](file:///Users/shijianzhong/sking/one/src/renderer/src/components/MentionComposer.tsx)
- 后端优先 token、回退旧 `@名字`：`resolveMentions`

残留：用户手打 `@名字` 仍受旧正则字符类限制；重名时名字回退仍脆弱（芯片路径已走 id）。

## 3.2 运行时隔离

### 风险 3：HITL（2026-08-08：run-scoped 清理已接入）

证据：[`userInput.ts`](file:///Users/shijianzhong/sking/one/src/main/orchestrator/userInput.ts)（`runId` + `rejectUserInputsForRun`）；home / orchestrate finally/cancel 按本 run 驳回。

残留：多窗口 / 同通道多并发 run 仍靠 AbortController 单槽；全局 `rejectAllUserInputs` 仅保留给测试/进程级清理。

### 风险 4：工具权限（2026-08-08：资产级白名单字段已接入）

证据：

- `Agent.allowedToolNames` / `Capability.allowedToolNames` + `filterToolsByAllowlist`
- 组队 / 编排 `resolveAgent` 按节点快照 → 源资产过滤

残留：管理页 UI 尚未暴露白名单编辑；未设白名单时行为与从前一致（全量快照 + MCP `exposeToAgents` + 调用级审批）。

## 3.3 资产恢复闭环

### 风险 5：proposal 草稿（2026-08-08：落盘 + 水合已接入）

证据：

- `propose_*` → `userData/drafts/create-*.json`；启动 `hydrateCreateDraftsFromDisk`；`listPendingDrafts` 重挂确认卡
- CrashRecovery 弹窗排除 `create-*`（避免与确认卡双通道）

残留：崩溃弹窗仍不自动灌回输入框/画布；创建卡依赖会话 `sessionId` 匹配重挂。

### （已修复，勿再当缺口）组队节点 `apiFormat`

复核时主 Agent、首页组队 `resolveAgent`、编辑器编排的 `llmOpts` **均已包含** `apiFormat`（[`ipc/home.ts`](file:///Users/shijianzhong/sking/one/src/main/ipc/home.ts)、[`ipc/orchestrate.ts`](file:///Users/shijianzhong/sking/one/src/main/ipc/orchestrate.ts)）。旧版评审里的「组队漏传 → OpenAI 协议必挂」**与当前代码不符**，不再列入风险表。

---

## 四、哪里还不足

### 4.1 首页主链路文件偏重

`src/main/ipc/home.ts` 仍然承担了太多职责：

- 记忆注入
- 提及解析
- 主 Agent 路由
- 创建链路
- 组队运行
- HITL / 审批桥

这不是马上要重构的 P0 问题，但会成为后续最容易继续膨胀的文件。

### 4.2 崩溃恢复目前更像“提示框”，不是“完整恢复工作流”

当前 `CrashRecoveryDialog` 能做到：

- 拉取草稿
- 展示内容
- 复制
- 忽略

但还做不到：

- 自动恢复到首页输入框
- 自动恢复到编辑器当前上下文
- 自动恢复创建确认卡

所以它现在更偏“最后兜底”，还不是“无缝恢复”。

### 4.3 E2E 覆盖还不够支撑资产链路信心

当前 `e2e/` 里主要有：

- `smoke`
- `list-page`
- `vault`
- `repro-capability`

缺少一条真正关键的长链路：

- Registry 导入资产
- 首页 @召唤
- ask_user / approval
- 创建确认卡
- 资产入库 / 再运行

这使得“单模块有测试”不等于“主链路闭环可靠”。

---

## 五、尤其关心：主 Agent 自由召唤资产，现在能不能走通

### 已经能走通的部分

- 纯 `@角色`（`directAgent`）：直跳跑角色图（见 `home.ts` 分流注释与分支）
- 纯 `@单能力`（`focusCap`）：**不直跳图**；注入 `buildCapabilityFocusBlock`，由主 Agent 介绍或吐出 `capability_ids` 组队 JSON；若落地为单能力 JSON，则 `buildTeamGraph` 返回真实 capability graph
- 芯片 `@` 序列化为 `@[kind:id]` 稳定 token（手打 `@名字` 仍兼容回退）
- 角色+能力 / 多能力：外层 sequential + 能力真子图嵌入（不再伪 agent）
- `@skill` 注入 Skill ContextProvider（与 persona `skillIds` 去重）
- `propose_* -> 确认 -> 入库`；确认卡草稿落盘并可水合重挂
- HITL ask_user / approval 按 run 清理（home ↔ orchestrate 互不整池误伤）
- MCP `exposeToAgents` + 可选 `allowedToolNames` 资产级白名单 + 调用级审批闸门

### 还不能算完全走通的部分

- 复杂能力图混合的边界边 / 多入口仍需真实资产回归
- 手打 `@名字`、重名回退仍脆弱（芯片路径已稳）
- CrashRecovery 仍不自动灌回输入框/画布
- 资产白名单尚无管理页 UI；Registry 信任标记未做
- 缺资产长链路 E2E

### 结论

**现在的状态更适合叫“主 Agent 已经具备资产调用能力”，还不能叫“主 Agent 可以自由、稳定、可控地召唤任意资产”。**

---

## 六、下一步迭代方向

建议优先级如下。

### P0：先补资产调用协议

目标：把“自由召唤资产”从 demo 能力升级成稳定能力。

建议：

1. 把 `@名字` 协议升级为稳定 asset token / id 协议
2. 允许 capability 作为真实子图节点参与组合，而不是降级成 description-agent
3. 给主 Agent 的路由输出加更强约束，避免复杂资产组合时语义漂移

### P1：补运行时隔离

目标：让多 run、多轮、HITL、审批不互相污染。

建议：

1. `userInput` 改成 `runId` / `sessionId` 作用域
2. `rejectAllUserInputs` 改成按 run 清理，而不是全局清理
3. approval queue 和 ask_user queue 做统一的 run-scoped runtime state

### P1：补资产权限模型

目标：在已有 MCP `exposeToAgents` 之上，做到资产被召唤时“可控”，而不是“快照里有就能用”。

建议：

1. 给持久化 agent / capability 增加工具白名单（或等价声明）
2. 把 MCP / shell / browser 等高权限工具纳入统一授权策略（服务器级 + 资产级）
3. 给 Registry 资产增加信任来源 / 风险标记 / 默认授权策略

### P1：补恢复闭环

目标：主 Agent 创建资产这条链路在崩溃后仍能续上。

建议：

1. proposal 草稿落盘
2. 恢复后可一键重新挂载确认卡
3. 首页输入框、编辑器画布、创建卡三类草稿走统一恢复模型

### P2：补产品化观测

目标：让平台后续更容易诊断和演进。

建议：

1. run 级 trace id
2. session / agent / provider 的 token usage 持久化
3. 首页路由命中率、工具调用成功率、HITL 中断率的统计能力

### P2：补完整 E2E 主链路

至少要加一条：

1. 导入 Registry 资产
2. 首页 @召唤角色/能力/技能
3. 触发 ask_user / approval
4. 触发 propose / confirm
5. 二次运行验证资产可用

---

## 七、建议落地顺序

如果只看性价比，我建议按下面顺序推进：

1. **资产引用协议升级**
2. **运行时隔离（run-scoped HITL / approval）**
3. **proposal 持久化与恢复**
4. **capability 真子图组合**
5. **资产级工具权限模型**
6. **主链路 E2E**

---

## 八、最终判断

这个项目当前最强的地方，是它已经有了一个相当不错的平台骨架：

- 安全边界对
- 分层对
- 执行内核对
- 资产模块化方向对

它当前最欠缺的，不是“再多写几个功能”，而是把资产调用这件事真正做成**稳定协议 + 运行时隔离 + 恢复闭环 + 权限控制**。

如果用一句话概括下一阶段目标：

**从“能跑的桌面 Agent 平台”，升级到“资产可组合、可控、可恢复的桌面 Agent OS”。**
