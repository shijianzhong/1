# One 插件能力迭代架构方案

> 目标：让 `one` 像 `deepseek-harness` 一样具备**可迭代的插件能力**——新增能力有清晰的挂点、可安装/卸载、有生命周期与所有权。本文是基于当前代码事实的架构方案，**只出文档，不改代码**。
>
> 本文件是 [`docs/DEEPSEEK_HARNESS_LEARNING_PLAN.md`](./DEEPSEEK_HARNESS_LEARNING_PLAN.md) 的**针对性深化**，不是替代；那份文档是"学 dsh 的整体盘点"，本文聚焦**插件能力**这一个横切主题，并把 dsh 的插件模型逐条映射到 `one` 现有模块。

---

## 1. 定位与边界（先立规矩，避免过度设计）

`one` 是单产品桌面应用，不是通用 agent SDK。去学习 plan 已明确表态：**不建 200+ package 的 monorepo、不把一切插件化、不重写成另一套 Cordis 框架**（`DEEPSEEK_HARNESS_LEARNING_PLAN.md` §"明确不建议照搬的部分"）。

所以本方案的目标不是"把 `one` 变成一个插件框架"，而是：

> **在现有产品结构里，把"新增能力该挂哪、怎么装、怎么退"变成一套统一的、有生命周期的、可文档化的契约。**

对 dsh "everything is a plugin" 的借鉴，截取其**核心收益**而非其**实现形态**：

| dsh 的机制 | one 要吸收的收益 | one 的实现形态 |
|---|---|---|
| Cordis 共享 `ctx`（service/event/effect） | 插件之间**按需协作、共享上下文、注册表变更可回滚** | 已有的 `tools/registry` + 新增轻量 `pluginHost` |
| 每种能力 = Service Definition / Provider / Consumer（seam） | 换一个 provider 就换整个能力 | **按现有域收敛 seam**（tool / provider / middleware 三类） |
| `cordis.yml` 分层 + overlay（可 patch） | 插件**可见、可启停、可覆盖** | **插件 manifest（JSON）+ UI 开关** |
| 注册是可逆 effect（卸载即回滚） | 插件卸载时**清理注册/事件/副作用** | `unregisterByPrefix`/`unregisterTool` 已有 + 生命周期钩子 |
| events 是扩展点（waterfall + serial） | 插件可**在运行前后注入上下文、订阅运行事实** | `SkillContextProvider.beforeRun/afterRun` 模式推广 |
| self-modification（插件可**遍历并装配自己的运行时**） | 让"AI/用户**现场**提出一个工具、立刻可用、可持久化"成为一等能力 | registry 动态注册 + 持久化 manifest + 受控执行出口 |

**一句话本方案的形态**：不引入第三方 IoC，把 `one` 现有的四类"扩展"（builtin 工具 / Skill / MCP 工具 / Registry 资产）**收敛到统一接口、统一 manifest、统一生命周期**，并给出一张"我想加 X 该改哪"的扩展点地图。

---

## 2. 现状盘点：one 已经有的四类扩展

按代码事实逐类核对（详见 `DEEPSEEK_HARNESS_LEARNING_PLAN.md` 范围与事实依据）：

**① builtin 工具**（`src/main/tools/registry.ts`）
- 全局 `Map`，`registerTool(name, description, zod, handler, approvalMode, options)` 注册，`executeTool` 走 `preCheck → approval 闸门 → 重试`。工具名冲突 warn 不 throw；支持 `unregisterTool` / `unregisterByPrefix` / `hasTool`。
- **现状短板**：builtin 都是**静态打包**进主进程（不经 `import()`/`require()` 动态加载，`src/main/index.ts` 全静态 import）。但需注意**系统整体已具备**运行时加载第三方工具的能力——MCP adapter 就在运行时把第三方 server 的工具 `registerTool` 进同一注册表（见下方"③ MCP 工具"），这是 PluginHost 薄壳想要的"运行时动态注册+卸载"的现成能力。注册点是全局单注册表，`RegisteredTool` 只有 `def/handler/zodSchema`，没有"来源/owner"维度（工具"来源"仅隐含在命名前缀 `mcp__{serverId}__` 里，非 registry 字段）。

**Skill**（`src/main/skills/provider.ts`）
- Skill = **ContextProvider**：`beforeRun` 把绑定的 SKILL.md inline 成 `<skill>` XML 块 + 输出纪律段拼进 instructions；`afterRun` 做审计。脚本走 `skill_run_script`（async spawn）。
- **现状短板**：当前只是 instructions 注入 + 一行审计，缺"可观测的 runtime record"和"per-agent 可变状态"（`provider.ts:12` 注释明确留了扩展点）。

**MCP 工具**（`src/main/tools/mcp/`）
- 外部协议工具，`客户端+adapter` 启动时连 enabled server，`mcp__{serverId}__{toolName}` 命名，连接/断连调用 `registerTool`/`unregisterByPrefix`，approvalMode 默认 always。
- **现状**：这已经是一个"可插拔源"的绝佳样板——有配置、有启停、有命名空间、有卸载清理。**这是 one 插件能力最接近的现成实现**。

**Registry 资产**（`docs/REGISTRY_PLAN.md`，kind = `agent` / `skill` / `capability`）
- 分发端：浏览/导入/导出/Token+源管理/自动 PR/star/一键更新。这是 **可用资源的分发**，不是运行时插件执行。

> **结论**：`one` 已经有"插件"的雏形（MCP 是最像插件的），缺的是把它们**收敛成一个统一契约**、**一份扩展点文档**、以及让 builtin/skill 也具备"来源、生命周期、可回滚"语义。
>
> **本轮补充的一个关键空白**：`one` 目前在**运行时**没有任何"由 AI / 用户现场提出一个新工具、立刻可用"的能力（`registerTool` 支持动态注册，但没有把"描述式定义 + 持久化 manifest + 受控执行"串成闭环）。这是"在聊天里让 AI 造一个工具（如刚在你 dsh 里体验过的 `cad_draw`）、造完就能用"要填的洞，见 §3「生成形态」与 §5 Stage 2。

---

## 3. 统一插件模型（one PIN-Plug）

一个插件 = **某个受支持 kind 的、带 manifest 的、可启停可卸载的扩展单元**。

```ts
// 契约（target 占位，落地在 src/main/plugins/contracts.ts）
interface OnePluginManifest {
  id: string                      // 全局唯一，命名空间如 'builtin/memory' | 'mcp/server-id' | 'skill/{id}' | 'generated/cad' | 'ext/xxx'
  kind: PluginKind                // builtin | mcp | skill | generated | external   （Registry 资产分发到三种再转 manifest）
  name: string
  version: string
  description: string
  enabled: boolean
  source: string                    // 分发来源：builtin | mcp | skill | registry | external   （kind 决定在哪个域值/安全模型，source 只记录"从哪分发来"，不重复 kind）
  // 可逆效果描述：注册了什么工具 / 注入了什么上下文 / 占用了什么存储
  // 卸载时按此清单回滚，不留下孤儿注册或残留数据。
  effects: {
    tools: string[]                 // 注册的工具名前缀（供 unregisterByPrefix 清理）
    storage: string[]               // 插件独占的表 / JSON 配置键（卸载时清理）
  }
}

interface PluginLifecycle {
  onLoad(ctx: PluginHost): Promise<void>   // 注册工具/订阅/建表。⚠️ 仅适用于长生命周期插件（builtin/mcp/skill-host 级），per-run 短命对象不走此钩子。
  onUnload(reason: 'disable' | 'uninstall' | 'shutdown'): Promise<void>  // 回滚 onLoad 的 effects
  onStart?(ctx, opts): Promise<...>        // 一次真实运行的入口（可选，如长生命周期插件的运行入口；Skill 的 beforeRun 走构造注入，不在此钩子）
  onStop?(): Promise<void>
}

> **注入方式定死（别让 onLoad 混进 per-run 语义）**：`PluginHost` 注入 `SkillContextProvider` 走**构造参数**，不走 `onLoad(ctx)` 生命周期钩子，也不走全局单例。代码事实：`SkillContextProvider` 当前在 `orchestrate.ts:167`、`home.ts:327/519` **每次运行 `new` 一个**（per-run 短命对象，构造参数已用于传 `getSkill` 函数引用），不是模块级长生命周期对象。`PluginLifecycle.onLoad(ctx)` 的语义是"插件加载时调一次"——与 per-run `new` 的频次不匹配，硬套会让"持 `this.host` 引用"退化成每次构造重新拿 ctx、且与"加载/卸载"生命周期混淆。
>
> 故 Stage 1 定死如下：
> - `SkillContextProvider` 保留 per-run `new` 模式，**构造参数扩一个** `host: PluginHost`（与现有的 skill 解析函数形参并列——provider.ts 里该形参名为 `resolveSkill`）。新增形参**不要求**三处 call site 传同一个函数引用：复用各自既有的 skill 解析实参（`orchestrate.ts:167` 传 `getSkillCached`；`home.ts:327` 传带 mention 过滤的内联箭头 `(sid) => (mentionSkillIds.has(sid) ? getSkill(sid) : null)`；`home.ts:519` 传 `(sid) => getSkill(sid)`），再加一个 `host` 实参即可。
> - call site 三处各加一个 `host` 实参——**这是 Stage 1 唯一必改的 call site**，显式、可枚举、易回归。
> - `beforeRun(input)` / `afterRun()` 签名**不变**；内部经构造时拿到的 `this.host.events` / `this.host.storage` 访问 host 能力。
> - `onLoad/onUnload` 留给真正的长生命周期插件（builtin 工具包、MCP server、skill-host 级管理器），不套到 SkillContextProvider 上。
>
> 这同时回答了 §3「两套 ctx shape 的取舍」选 **A**：run-scoped 数据（`input`）走参数、host 能力（`ctx`）走构造引用，两类信息不混；但 A 的"持 `this.host`"改为**构造时持**而非 `onLoad` 时持，以贴合 per-run 事实。全局单例方案被排除——它会让 per-run 状态与 host 绑死到单例，回归"插件=全局可变状态"的老问题。
```

**运行时的 `PluginHost`** 是插件之间唯一的协作面，对应 dsh 的 `ctx`，但极轻量：

```ts
interface PluginHost {
  tools: {                             // 封住对全局 registry 的直接 mutable 操作
    register(spec): PluginHandle
    unregister(prefix): number
    list(): ToolDef[]
  }
  events: {                            // 类型化事件，插件可订阅运行事实 / 生命周期
    on<K>(type, listener): Unsubscribe
    emit(type, payload): void
  }
  storage: { /* 只允许插件声明并清理自己的表/JSON */ }   // 可选 P2+
}
```

### 设计取舍（对 dsh 的截取）

> **Stage 1 的取舍（已定 A）：两套 ctx shape 不能并存到落地。** §3 契约里 `PluginLifecycle.onLoad(ctx: PluginHost)` / `onStart(ctx, opts)` 用的是 **PluginHost 型 ctx**（host 能力：`tools/events/storage`，稳定、跨运行）；而真实 `SkillContextProvider.beforeRun(input)` 用的是 **run-scoped input**（`{ agentName, skillIds, instructions }`，每次运行不同），**没有 ctx 形参**。这两者不是"有没有 ctx"的差别，而是**承载的信息类别不同**——一个是 host 能力句柄，一个是本次运行数据。Stage 1 要定的不是"是否拓宽 `beforeRun` 签名"（定论：不拓宽），而是 **skill 怎么拿到 PluginHost**，有三条路：
>
> - **A 保留 `beforeRun(input)` + 构造参数注入（推荐，已定）**：`SkillContextProvider` 保留 per-run `new`，**构造参数扩一个 `host: PluginHost`**（与 provider.ts 既有的 skill 解析函数形参 `resolveSkill` 并列），`beforeRun(input)` / `afterRun()` 签名不变，内部经 `this.host` 访问 host 能力。call site 三处（`orchestrate.ts:167` 传 `getSkillCached`、`home.ts:327` 传带 mention 过滤的箭头、`home.ts:519` 传 `(sid)=>getSkill(sid)`）各自复用既有 skill 解析实参、再加一个 `host` 实参——Stage 1 唯一必改的 call site，显式可枚举。run-scoped 数据走参数、host 能力走构造引用，两类信息不混。**注入方式见 §3「注入方式定死」**——走构造参数，不走 `onLoad`，不走全局单例。
> - **B 参数注入 `beforeRun(input, ctx)`**：ctx 作第二参显式传入，更显式无隐状态，但所有 call site 要改、`afterRun()` 当前无参也要加参。
> - **C 统一到 `onStart(ctx, opts)`**：skill 改走 `onStart`，`input` 合进 `opts`——改动最大，且把 run-scoped 数据塞进 `opts` 会模糊 `input` 的明确语义。**不推荐**。
>
> 已定：选 **A（构造参数注入）**，见 §3「注入方式定死」与 §5 Stage 1 决策项——`beforeRun(input)`/`afterRun()` 签名不变，host 经构造参数注入。B/C 不采用。

- **不引入第三方 IoC**：`PluginHost` 只是把现有 `registry.ts` + `run_events`（**已落地**，见 `storage/runEvents.ts`）+ Skill 注入**包一层稳定 API**，不换底层。
- **命名空间是生命周期边界**：每个插件用一个**工具名前缀**声明所有权，卸载 = `unregisterByPrefix(name+)`，这是 dsh"注册是可逆的 effect"的最小实现，`mcp__` 已在用。
- **kind → 具体实现**：不搞一张所有东西都编得进来的抽象。kind 决定插件在哪个具体域生效（工具注册表 / Skill 注入 / 订阅事件），清晰且不抽象泄漏。

### 生成形态：同一个 `generated` kind，分两层安全上界

> 这是本方案对 dsh `self-modification` 的一次定向吸收，也是最贴近"**在聊天里让 AI 造一个工具（如刚才的 `cad_draw`），造完立刻能用**"的落实方式。它刻意**不引入整套自修改框架**，只落一个最小闭环。

`generated` 插件 = **由 AI / 用户**（不一定是代码作者）在运行时提出的一个工具，持久化成 manifest 后即可被 LLM 调用。按**执行的程序化程度**分两层，**决策上浮**：

| 层 | 工具长什么样 | executor 由谁给 | 能否执行受控副作用 | 安全边界 | 阶段 |
|---|---|---|---|---|---|
| **A 声明式 AI 工具** | 只描述 `name/description/zod schema` + 一个**受控动作声明**（`executeAction: { action: <只读/检索白名单成员>, params? }`，**动作必须是下方只读/检索白名单成员**；此处为示意，完整正列见下方"A 动作白名单"——含 `file_read`/`file_search`/`kb_search`/`web_search`/`glob`/`grep`/`skill_search`/`load_skill` 共 8 个） | `PluginHost.tools.register` 直接用，executor = 现有受控引擎 | 只能**判发白名单内的、无副作用的只读/检索动作**；不能执行 shell/write/任意代码 | **无新执行面**：A 的白名单是**明确正列（whitelist）**，不含 `shell_run` / `file_write` / `create_*` 等任何能改动系统或执行任意命令的动作，见下方"A 动作白名单" | **P0-核心** |
| **B 代码型工具** | 用户/AI 给出一段**可执行 handler 源码**（对标 dsh bundle / external 插件） | 自定义 handler，主进程受控加载 | 是（自定义逻辑，含 shell/write） | fail-closed：白名单 + 显式信任 + 主进程专属 + 审批闸门 | **P3-后置** |

**A 层"受控动作"必须是明确正列（whitelist），不是"任意既有工具名都放行"。** 一个动作只有**要么只读、要么只检索、绝不产生副作用**才进白名单。以现有 `builtin` 为准，白名单初版 = 只读/检索子集：

> **A 动作白名单**：`file_read`、`file_search`、`kb_search`（检索）、`web_search`（检索）、`glob`、`grep`（纯检索）、`skill_search`（FTS 检索已安装技能）、`load_skill`（按 id 读技能全文，只读）。**白名单外的一律放 B 或走既有 approval 闸门兜底**，尤其：`shell`/`skill_run_script`（exec 任意命令）、`file_write`/`strReplace`（写盘）、`create_*`/`assetCrud`（写资产）、`opencli`/`poster`/`gh`（外部副作用）、`ask_user`（HITL）。
>
> 注：`skill_search`/`load_skill` 由 `tools/builtin/skillRag.ts` 注册（文件名 `skillRag`，但**注册的工具名**是这两个，全仓无名为 `skillRag` 的工具）。白名单以**注册工具名**为准。

**白名单是执行期强约束，不是声明级承诺**：A 的白名单校验**必须发生在 `PluginHost.tools.register(generated/A)` 的注册点**——manifest 里 `executeAction.action` 若不在上述正列，`register` **直接拒绝（fail-closed 于注册点）**；同时该校验还要确认 **A 给该动作的 `params` 是被动动作 schema 的 `pick`/`subset`**（不得定义被动动作没有的参数），否则一并拒绝。拒绝都写成一条可观测事实（`run_events`）。这样"白名单"就从"作者承诺用只读动作"变成"运行时无论如何都到不了白名单之外"，A 的"无新执行面"才可真验证。判定杜绝写进 handler、由插件自身执行。

**A 的动作沿用该动作自身的既有语义，不另开权限**：`file_read`/`file_search` 继承文件工具既有的 `ONE_FILE_ROOTS`/vault 路径围栏，`web_search`/`kb_search` 走各自检索方，重试/超时/审批沿用工具注册时已有定义。A 只做"用新 schema + 描述包装一个既有白名单动作"，**不创造任何更宽的访问路径**——否则 A 工具会变成绕过文件围栏的通道。

**A 给白名单动作的 `params` 必须是被动动作既有 schema 的 `pick`/`subset`**：A 只能**透传**该动作本来定义为 `params` 的那几个键（`file_read` 的 `path`、`web_search` 的 `query` 等），并在注册点校验——**A 不得新增该动作 zod schema 里不存在的参数**，也不得改变这些参数的既有语义/约束。这样"一个 action + params"永远等价于"调一次该既有动作本身"，A 就不会变成绕过既有签名校验（`resolveConfined`/schema) 的旁路。若某工具确实需要更宽的入参，那已不是对既有动作的包装，应升级 B 或新增一个真正的 builtin。

> 这样才没有张力：**"A 低风险"建立在"A 永不 exec、永不写盘"之上**——A 唯一的动作就是读/查，可观测、可审批、可回滚，执行权限始终在受控引擎手里，从没有一条路让 A 碰到 shell。若某场景确实需要 shell，那是 B（或走审批闸门）的事，不是 A。

关键判断：**大多数"我想让 one 有个新能力"的场景，走 A 就够了**——但前提是诉求属于"读/查某类数据再按固定规则组织输出"。例如"按某目录的 markdown 批量整理成一张概况表" = A 白名单内的 `file_read`/`file_search` + 自定义 schema 包装；"搜知识库再汇成一段固定结论" = `web_search`/`kb_search` + schema 包装。而**一旦诉求要 exec 命令、写盘、写资产或产生外部副作用——比如真正的"绘制几何并落盘成 SVG"——就不再是 A**，而是 B（交付代码，主进程受控加载）或经既有 approval 闸门兜底（判发到 `shell`/`skill_run_script`）。B 只保留给确实需要新逻辑、白名单读/查组合不满足的情形，严格 fail-closed 后置。

> 收回先前"绘图走 A"的说法：**触及写盘/exec 的一律不属于 A**。真正的 `cad_draw` 式"造一个产出图形的工具"在 `one` 里要么走 B（让 AI 给 render 源码，主进程受控加载），要么由既有受控工具（`file_write` + 渲染回调）经既有 approval 闸门触发——都不是声明式 A。A 的价值窄但干净：它是"只读/检索的领域小工具"的现场装配，低风险的前提就是这个"窄"。§5 据此把 A 列为 P0，B/外部副作用列后置。

---

## 4. 扩展点地图（"我想加 X 该挂哪"——只读文档，落地立即可得）

对齐 dsh `docs/architecture.md` 的 "Where new behavior goes"，按问题组织而非目录组织。每条给：推荐入口 / 不选入口 / 原因。**这条本身是零成本纯文档**（学习计划修订 13 已评为此，可直接做）。

| 我想…… | 推荐入口 | ⚠️不推荐入口 | 原因 |
|---|---|---|---|
| 加一个给 LLM 的新工具能力 | `tools/registry.ts` 调 `registerTool(…)+` 在 `tools/builtin/` 加模块；若外部服务则走 `tools/mcp/` | 塞进 `ipc/home.ts` 或 `orchestrator/runner.ts` | 工具只有注册进 registry 才会进 `listAgentToolDefs` 进 LLM 可见 dict；放进编排层会破坏"Agent≠tool-use 循环"铁律 |
| 加一个会话级策略 / preCheck / approval 规则 | 用 `registry.registerTool` 的 `options.preCheck`，或 `registry.ts` 的 approval 闸门 + `sessionApprovals` | 写进 handler 内部 if 分支 | 闸门序列（preCheck→审批→重试）统一，散落 handler 会被绕开 |
| **在聊天里现场让 AI/用户造一个新工具，造完立刻能用** | 走 `generated` kind 的 **A 声明式 AI 工具**：`name/description/zod schema` + 一个只读/检索白名单动作声明 → `PluginHost.tools.register` 运行时注册（白名单在注册点强校验，非白名单直接拒注册）+ 持久化 manifest（§3"生成形态"）；需要新逻辑再升层 B | 让 AI 直接改 `src/main/tools/builtin/*.ts` 源码后热重载 | 声明式 A 只需描述参数并判发**只读/检索白名单动作**，且白名单在注册点 fail-closed、动作继承既有围栏；零新增执行面；改源码则把"工具加入"绑死在编译期，无法现场生效，也是更大的攻击面；B 代码型严格 fail-closed |
| 加一个 skill 运行时行为（注入 / 校验 / 审计） | `skills/provider.ts` 扩展 `SkillContextProvider` 或订阅 `PluginHost.events` | `beforeRun` 里硬编码深层逻辑 | Skill 现在只做 instructions 注入 + afterRun 审计，hook 应保持注入器职责。**注意当前真实签名**：`beforeRun({ agentName, skillIds, instructions })` / `afterRun(): void`（无 `session/context/state`）；要接事件总线/per-agent 状态，Stage 1 经构造参数注入的 `this.host` 访问（`beforeRun`/`afterRun` 签名不变，见 §3「注入方式定死」） |
| 加一个外部工具服务 | `tools/mcp/` 配置 + adapter | 自己 `registerTool` 裸连 | MCP 给生存期 disconnection 清理、命名空间、approval 默认值兜底 |
| 加一个按能力域的"子能力卸载" | 用 `unregisterByPrefix(pluginName+span)` 回滚 | 在 runtime 里强删 registry | 前缀是所有权边界，回滚防孤儿名 |
| 加一个运行事实/诊断点 | `run_events` 体系（持久化事实，`storage/runEvents`）+ `PluginHost.events`（App 内实时总线） | logger 打个 `console` | 持久化事实才能回放；`run_events` **已落地**（`storage/runEvents.ts` + `db.ts` `run_events` 表 + orchestrator/scheduler/ipc 全链路写盘），不再是"P0 待办"；`PluginHost.events` 是其上的轻量实时投影，不重复建持久层 |
| 给插件加"配置项 / 启停开关 / 密钥引用 / 设置页" | manifest 里 `configSchema` + 现有 settings/vault IPC（密钥按 `getKey()` 引用,入主进程不落渲染层） | 让插件自己直连存储/环境变量读密钥 | 配置与密钥都是**声明式资源**，走既有设置与 vault 才符合铁律——插件只声明、框架提供存取 |

> 落地物：`docs/RUNTIME_EXTENSION_MAP.md`。规则：P0–P3 每个改造动某个挂点时，顺手记一条"入口/不入口/为什么"，文档跟改造长，不后端回溯。

---

## 5. 分阶段路线（低风险，逐层收敛）

> 目标：**先不改任何功能，先加契约 + 文档 + 收口到一个入口，再逐个让 builtin/skill 具备"插件化"能力**。每阶段都可独立交付、可回滚、不破坏既有功能。**每阶段都给出完成定义（验收）**，避免"阶段永远进行中"。

### Stage 0 — 契约 + 扩展点文档（纯文档，零重构）
- 新建 `docs/RUNTIME_EXTENSION_MAP.md`（上面 §4）。
- 建 `src/main/plugins/contracts.ts` 只放 `OnePluginManifest` / `PluginHost` / `PluginLifecycle` 接口（类型 only，无运行时代码）。
- **验收**：`contracts.ts` 能独立通过 tsc；`RUNTIME_EXTENSION_MAP.md` 落到 docs（无 `pending` 空行）；启动回归测试全绿。

### Stage 1 — PluginHost 薄壳 + 事件总线
- 把 `registry.ts` 的 `registerTool/unregisterByPrefix/list` 包成 `PluginHost.tools`（只读代理 + 审计），**不改变现有调用**（回归零）。
- 在已落地的 `run_events` 体系上（`storage/runEvents.ts` + `db.ts` `run_events` 表，写盘点已遍布 orchestrator/scheduler/ipc）暴露 `PluginHost.events`，让 skill/外部插件可订阅运行事实。该前置已满足，Stage 1 可立即开工，不必等"P0"。
- **明确决策（Stage 1 前置，已定）**：skill 接入 PluginHost 走 §3「两套 ctx shape 的取舍」选 **A**——**构造参数注入** `host: PluginHost`（保留 per-run `new`，`beforeRun(input)`/`afterRun()` 签名不变），不走 `onLoad(ctx)`、不走全局单例（理由见 §3「注入方式定死」）。call site 三处（`orchestrate.ts:167`、`home.ts:327`、`home.ts:519`）各加一个 `host` 实参，是 Stage 1 唯一必改的 call site。
- **验收**：现有 builtin 全部改经 `PluginHost.tools` 后，`runEvents` 事实流与 UI 行为无回归；一个最小订阅者能在 tool.completed 事件里收到带 toolName/runId 的载荷。

> **（承接原文档 Stage 2 的"用 manifest 统一来源与生命周期"）** 并行给 **MCP server**、**Skill**、**(optional)** builtin 各自加一份轻量 manifest（从 Registry 分发或本地 `manifest.json` 读取），统一入口 `src/main/plugins/registry.ts`：`loadEvery plugin → startAll enabled plugins → stopOnUninstall → disposeOnExit`（对齐 MCP 已有的 initMcpServers / disconnectAll 模式，推广之）。每个插件的 `onUnload` 调 `unregisterByPrefix` + 清理自己建的存储 + 取消订阅事件；**start→stop 的生命周期顺序在契约文档里写死**。这不是新增阶段，而是 Stage 1 收口的自然延伸，是让 `generated`（下一 Stage 2）能和其他 kind 一样"可启停、可回滚、有 manifest"的前提。

### Stage 2 — 声明式 AI 工具（`generated` kind，A 层）——**"现场造工具"闭环**
- **前置（先落 manifest 持久化）**：工具声明存成 `generated/{id}/` 的 `manifest.json`；`onLoad` 读盘并 `register`，`onUnload` 调 `unregisterByPrefix(generated/{id})` 并清理该插件专属存储。**只有先有持久化与清理，"造完重启后还能用、卸载无残留"这条体验闭环才成立**，所以它是 Stage 2 的**前置**而非补丁（因此它原在 §6 标注的"存储可回滚 P2"要提前到 Stage 2 落地）。然后才是：`register` 运行时注册 + 启停开关 + `unregisterByPrefix(generated/{id})` 回滚。
- 复用已完成事件总线：注册/卸载发 `PluginHost.events`，调用走既有审批闸门，执行动作用现有受控引擎调度，**不给任意代码**。
- **插件管理页（`/plugins`，显式交付项）**：用户在主 agent 聊天里造的 `generated` 插件**必须有地方看到**，不能造完变黑盒。落地：
  - 新增 `src/renderer/src/pages/PluginsPage.tsx`（页面壳），**复用 `McpSettings` 组件（`src/renderer/src/components/McpSettings.tsx`，由 `McpPage.tsx` 承载）的"列表 + Switch 启停 + enabled 字段 + `window.one.mcp.listServers()`"模式**——`McpPage.tsx` 本身只是 19 行壳（只 `<McpSettings />`），真正的列表/启停/增删改逻辑在 `McpSettings` 组件里。列表统一展示所有 kind 的插件——`generated/`（用户造的）、`mcp/`、`skill/`、`builtin/`——每行显示 `name / kind / enabled / source`，对应 `OnePluginManifest` 契约块（§3 L63-77）的字段。
  - `generated` 插件可展开查看 manifest 详情：`name/description/zod schema/白名单 action`——让"造完不是黑盒"，用户能核对自己造的工具到底声明了什么。
  - 操作：启停（改 `enabled` → 走 `onLoad`/`onUnload` 回滚 effects）、卸载（`unregisterByPrefix` + 清理专属存储 + 删 manifest）。
  - **IPC 契约**：主进程经 `withHandler`（定义在 `src/main/ipc/handler.ts:12`，规范见 `CLAUDE.md` §11.3）暴露只读视图 `plugins:list` → `OnePluginManifest[]`（从 `PluginHost` 读，不另起注册表），写操作 `plugins:enable/disable/uninstall`（调 `PluginHost` 的生命周期钩子，卸载走 `onUnload`）；经 preload 白名单暴露为 `window.one.plugins.*`，返回 `IpcResult<T>` 判别联合（定义在 `src/shared/types.ts:45`，渲染层用 `isIpcFailure()` 解包）。注册/卸载事实同步记 `run_events`。
- **验收**：在聊天里让 assistant 造一个**无副作用的声明式工具**（如一个"按指定参数生成一段技术图纸描述"或"读某文件并按固定模板整理"的工具），造完立刻被 `listAgentToolDefs` 收录、可被同会话或后续会话调用；**`/plugins` 页能看到该插件**（含 manifest 详情）；禁用后再调用返回"工具不存在"；卸载后 `unregisterByPrefix` 清干净注册、`/plugins` 页不再列出。**并实测注册点白名单 + `params` subset 校验**：声明一个白名单外的 `action`（如 `shell`）或给 `file_read` 新增一个它 schema 里不存在的参数，`register` 均应在注册点被拒并记 `run_events`。

### Stage 3 — 代码型工具（`generated_b` B 层 ✅ 落地 2026-08-26 / `external` 仍后置）
- ✅ **`generated_b` B 层已落地**：用户/AI 经 `propose_generated_b` 提出一段可执行 handler 源码 → `CreateConfirmCard` → 用户确认 → `home:confirmCreate` 走 `validateGeneratedBSpec` 闸门（handlerSource 非空 + vm 编译期验语法 + inputSchema 结构）→ `saveGeneratedBPlugin`（manifest.json + handler.js）→ `enableBPlugin` 注册。
- **vm 沙箱执行**（`sandbox.ts`，项目首次引入 node:vm）：`vm.runInNewContext` 编译 handler 源码，context **只注入 `executeTool`**，不暴露 require/process/global/__dirname——B handler 无法 require fs/shell。`executeTool` 是唯一能力出口，调白名单 8 动作（file_read/file_search/kb_search/web_search/glob/grep/skill_search/load_skill），白名单外返回 `action_not_whitelisted`。`runBHandler` 用 Promise.race + AbortSignal 做 60s 超时（vm timeout 只管同步段，async 在 microtask 不受管）+ 16KB 输出截断。
- **信任闸门三态**（`manifest.trustedBy` 决定）：null（未信任）→ 注册占位工具（approvalMode='auto'，返 `trusted_required` 提示引导用户去 /plugins 信任）；非空（已信任）→ 注册真 code handler（approvalMode='always'，每次弹审批）；校验/编译失败 → 不注册任何工具，emit `plugin.registered{status:'failed'}`。信任≠免审。
- **A/B 共用 `generated-plugins/` 目录根**，靠 id 前缀互斥（A=`gen_`、B=`genb_`，正则过滤无串扰）。信任切换：`plugins:trust` → `setTrustedBPlugin` 写盘 + disable+enable 重载切占位↔真 handler。
- 受既有安全边界约束：渲染进程零 Node 特权，加载只发生在主进程，且只经白名单暴露能力。
- **已知限制（同步死循环 DoS）**：`vm.runInNewContext` 的 `timeout` 仅能中止同步段；若已信任的 B handler 写纯同步死循环（如 `while(true){}`），`Promise.race` 的 abort 信号无法打断同步执行，会永久占住事件循环直至进程被杀。该路径**仅在用户于 /plugins 页显式"信任"后才可达（consent-based，主动授权后的自伤面）**，不构成未授权 RCE/DoS。未来根治方向：将 B handler 执行移入 worker thread（独立线程，可 `terminate()` 强杀）。见 `sandbox.ts` 头部注释。
- **验收**（已实现）：加载一个含任意 `require('fs')` 的 B 工具——vm 沙箱不注入 require，`require('fs')` 抛 ReferenceError；未信任时调到只返 `trusted_required` 不执行 handler 源码；显式信任后每次调用弹审批；卸载 `rmSync` 目录连 handler.js 一起删。超时/输出截断/白名单外动作拒绝均有结构化错误返回。
- `external` kind（外部代码插件，加载目录/registry 分发）**仍后置**——文档把 external 与 B 同列但可分，Stage 3 只做 `generated_b`。

### 标优先级
- Stage 0 + Stage 1：**核心收益**（扩展点文档 + 统一宿主）——性价比最高，风险接近零。
- Stage 2：**本轮用户要的"现场造一个工具立刻用"**——是 `generated/A` 的最小闭环；A 只判发只读/检索白名单动作（§3），**零新增执行面**，风险低。**排在 Stage 3 之前**。
- Stage 3：✅ `generated_b` 代码型能力已落地（vm 沙箱 + 显式信任 + always 审批，严格 fail-closed）；`external` 仍后置。

---

## 6. 与安全铁律的对照

接入插件能力必须守住已有铁律（`CLAUDE.md`）：

- **渲染进程零 Node 特权**：插件代码只跑主进程，经 `window.one.*` IPC 白名单暴露，不新增裸 IPC。插件注册工具 → `listAgentToolDefs` → 渲染层只拿 `LlmToolDef`。
- **密钥不入渲染进程**：插件加载在主进程，密钥（vault）也在主进程，插件按 keyId 经 `vault.getKey()` 解析明文（`secrets/vault.ts` 的 `getKey(keyId)` 已实现 keyId→解密，渲染层只持 keyId、明文不落渲染层）。不引入新的"CredentialRef"类型——文档先前所称的类比措辞在 `src/` 下并无对应实现。
- **fail-closed，分层递进**：**声明式 `generated/A`** 只判发只读/检索白名单动作（§3，不含 shell/写盘/任意命令），且**白名单在 `PluginHost.tools.register` 注册点强校验**——`executeAction.action` 必须在正列、其 `params` 必须是被动动作 schema 的 `pick`/`subset`（不得新增被动动作不存在的参数），任一不满足直接拒注册并记 `run_events` → 视为安全默认、`auto` 审批；**代码型（`generated/B` 或 `external` Stage 3）**默认拒绝/需显式信任，MCP 继续默认 `always` 审批。**别把两层混为一套信任模型**。A 动作继承各自既有围栏/审批/重试语义，不另开权限。
- **可回滚**：`generated` 的 manifest 持久化与卸载清理存储已在 Stage 2 一并实现（不再是 P2）；其他 kind 若申请存储需同样清理（P2）。

> 安全上，`generated/A` 之所以能成为强需求下的低风险 P0，本质是：**它没有任何新执行面**——新增的只是"一个名字 + 一段 schema + 一次对只读/检索白名单动作的判发"，且**白名单在注册点强制校验、动作继承既有围栏**，可观测（`run_events`）、可审批（既有闸门）、可回滚（`unregisterByPrefix`）。代码执行权限从始至终只在主进程受控引擎手里，A 从没有一条路碰到 shell 或写盘。

---

## 7. 与现有文档/里程碑的关系

- `docs/DEEPSEEK_HARNESS_LEARNING_PLAN.md`：本方案细化其 P1"把新增能力挂哪写成扩展点文档"（修订 13），并把已验收的 MCP 样板（动态工具源）显式泛化为统一插件宿主。
- `docs/REGISTRY_PLAN.md`：Registry 是**分发源**，本方案定义**挂载后的生命周期**。两者衔接干净：导入资源 → 生成 manifest → 挂到 `src/main/plugins` 宿主。
- `task.md`：本方案不做代码改动，产出契约，**不在 task.md 勾选里程碑**（只当文档增量）。真正落地时相应勾选新 milestone。

---

## 8. 一句话结论

`one` 的插件道路不是"自我重写成另一个框架"，而是把已有的**MCP（动态工具源）**、**Skill（上下文注入器）**、**builtin 注册表**、**Registry（分发）**四块**用一个 `PluginHost` 薄壳 + 一份扩展点文档收敛**，让"新增能力该挂哪、怎么启停、怎么回滚"有统一契约；并在此基础上，把 **"在聊天里现场让 AI 造一个工具、立刻能用"**（`generated/A` 声明式路径，对应你在 dsh 里刚体验过的 cad 插件）作为 `one` 离真实用户最近的第一优先阶段。第一步只需两件零成本的事：**写扩展点地图** + **建 PluginHost 契约**。
