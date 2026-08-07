# One 项目评审报告（基于当前代码实况修订）

> 修订时间：2026-08-07
> 校验范围：`docs/PROJECT_REVIEW.md` + 当前仓库源码 + `task.md` + `CLAUDE.md`
> 校验结果：`npm run typecheck` 通过；`npm test` 通过（42 个测试文件 / 340 个测试）

---

## 一、项目概况

**One** 是一个 Electron + React + 全 TypeScript 的 AI Agent 可视化编排桌面应用，当前版本 `0.1.13`。它把原 Proton（Python FastAPI + React Web 应用）重写为纯桌面应用，核心差异化能力是**自研的 Pregel 编排引擎**，支持 Sequential / Concurrent / GroupChat / Handoff 四种 Agent 协作模式。

---

## 二、优势

### 2.1 架构设计清晰，边界明确

- 三层进程模型（main / preload / renderer）职责分明，共享契约集中在 `src/shared/types.ts`
- IPC 统一经 `withHandler` 包装，主进程异常不会裸抛到渲染层
- Electron 安全基线做得扎实：`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`
- 密钥走 `safeStorage` + vault，不进入渲染进程

### 2.2 自研编排引擎完成度高

- 采用 Pregel superstep 执行模型，语义上不是静态拓扑排序，而是 N emit / N+1 deliver
- Sequential / Concurrent / GroupChat / Handoff 四模式已落地，且都带有针对性测试
- GroupChat 的 cache / dedup / fairness / manager_output 四个 patch 已接入运行时
- Handoff 采用 synthetic tool + 短路而不是额外谓词系统，设计比较克制

### 2.3 工程基础比较扎实

- 当前仓库实测 `42` 个测试文件、`340` 个测试通过
- SQLite/WAL/integrity_check/备份恢复链路完整
- 冷启动性能做过系统优化：manualChunks、路由懒加载、启动屏、首包瘦身
- Registry、MCP、Skill ContextProvider 这几块不是停留在设计层，而是已经有实装

### 2.4 产品化意识较强

- 有 Registry 浏览/导入/导出/自动 PR/一键更新的完整分享闭环
- 有崩溃恢复、自动更新、托盘、快捷键、原生菜单这些桌面端必需能力
- 有 i18n、主题系统、背景图、点缀色派生、Error Boundary 等横切基础设施

---

## 三、问题与短板

### 3.1 架构级问题

**1. LLM 协议适配（部分落地，2026-08-07 修订）**

配置层已有 `Provider` 抽象；执行层现已按 `apiFormat` 路由：

- `openai` → `OpenAILLMClient`（SSE / tool_calls）
- 其它（含 `custom`）→ Anthropic SDK（`custom` 会打 warn：按 Anthropic 协议发）

仍缺：Gemini 等原生协议；OpenAI 路径对 `tool_result.is_error` 的映射仍弱于 Anthropic。

**2. 渲染层测试明显不足，但不是零覆盖**

原先“渲染层零测试覆盖”的判断不准确。当前渲染层至少已有：

- `src/renderer/src/components/orchestra/reducer.test.ts`
- `src/renderer/src/lib/color.test.ts`

但整体上仍然偏弱，尤其是：

- React 组件
- 页面级交互
- Zustand store
- TanStack Query hooks
- ErrorBoundary / 路由 / 关键 UI 闭环

所以结论应修正为：**“渲染层测试覆盖明显不足，尤其缺页面级和组件级测试。”**

**3. `ipc/home.ts` 仍然偏大，职责较重**

`src/main/ipc/home.ts` 当前约 `812` 行，仍承担：

- 首页聊天
- 三级记忆拼装
- 提及解析
- 路由指令注入
- 创建草稿链路
- 团队运行分流
- stream 事件派发

这不一定是立刻要拆的 P0 问题，但的确是后续维护成本较高的点。

**4. Runner 仍接受菱形汇聚重复消息**

`runner.ts` 中依然明确保留了“菱形汇聚可能产生重复消息，MVP 接受”的实现备注。  
这说明该问题不是误报，而是当前设计上**已知但未消除**的行为缺口。在线性图为主时影响有限，但复杂编排图会放大这个问题。

### 3.2 功能闭环缺口

**5. 崩溃恢复（2026-08-07 修订：桥接已接通，写盘刚起步）**

已落地：

- preload：`onCrashRecovery`（含启动缓存防竞态）/ `listDrafts` / `writeDraft` / `removeDraft`
- 渲染：`CrashRecoveryDialog`（push + pull 双通道）
- 首页未发送输入、编辑器画布 debounce 会写 `userData/drafts/*.json`

仍需手工验证：崩溃后 Dialog 是否稳定弹出、恢复后用户如何把草稿贴回输入框/画布（当前以复制内容为主）。

**6. 工具生态仍有明确尾巴**

这部分原评审基本成立：

- `browser_use` / 浏览器自动化能力未落地
- `opencli_run` 仍是静态写操作动词拦截，尚未切到 `access: write`
- Windows 包尚未完成真实验证

### 3.3 代码质量与一致性问题

**7. Context window 管理仍是 MVP 级策略**

当前 runner/executor cache 的上限策略仍是“保首条 + 最近 N 条”的硬截断。  
这并不等于系统完全不可用，但确实说明：

- 没有 token 级精确预算
- 没有通用 compaction 策略
- 没有更高层的 prompt 预算编排

这一点应保留为真实短板。

**8. 错误 i18n 还没有真正收口**

原评审说“主进程错误仍含中文硬编码”，方向是对的，但还可以更精确：

- 主进程里部分工具已经开始返回 `messageKey`
- 但仍有大量 `hint` / 错误消息直接是中文或英文自然语言
- 渲染层也还有残留的用户可见硬编码，比如首页重试提示文本

所以更准确的判断是：**“i18n 的主路径已经建立，但 `errors.*` 和少量前端文案还没有完全收口。”**

**9. Markdown 渲染可以继续硬化，但不应直接定性为现有 XSS 缺口**

旧评审把这一条写成“Markdown 渲染无 XSS 防护”，这个结论偏重。  
当前使用的是 `react-markdown`，且没有启用 `rehypeRaw`，因此不能简单等同于“已暴露原始 HTML 执行风险”。

更准确的说法应该是：

- 当前实现未见明显高风险 raw HTML 注入配置
- 但 link/image/url 策略仍可进一步硬化
- 这属于“安全收紧建议”，不适合直接列为当前 P0 结论

**10. 工具失败语义不统一，真正的问题不是 `JSON.stringify()`，而是 `isError` 语义不一致**

旧评审抓到了现象，但根因写偏了。  
当前 `executeTool()` 的行为是：

- 参数校验失败、审批失败、抛异常失败时，`isError = true`
- 但很多工具把业务失败包装成 `{ ok: false, error, hint }` 返回
- 这些返回会被当作正常 `tool_result`，`isError = false`

这会导致模型拿到的是“结构化失败内容”，但从协议语义上看却不是 error result。  
这个问题比“返回值格式不统一”更核心。

### 3.4 可持续性问题

**11. 日志有 trace 风格，但还不是结构化可观测性体系**

“完全没有 trace”这个说法不准确。代码里已经有大量 `[trace:cap]` 风格日志。  
但它仍然不是完整的结构化日志方案，主要缺：

- 统一 trace id / run id 串联
- 机器可聚合字段
- 耗时、错误、token 的统一统计出口

所以结论应修正为：**“已有 trace 风格日志，但仍缺正式的结构化可观测性体系。”**

**12. Token usage 不是完全没有，而是只停留在日志级**

`LLMClient` 已经记录了 `finalMessage.usage`。  
真正缺的是：

- 按 session / agent / provider 的持久化
- UI 展示
- 成本估算
- 聚合分析

因此应从“完全缺失”修正为：**“已有 usage 日志，但没有产品级追踪与展示。”**

**13. MCP 意外断开后会自动注销工具，但不会自动重连**

旧评审这里基本成立。  
当前系统对 unexpected disconnect 的处理是：

- 清理 client
- 自动注销对应 MCP 工具

但没有 backoff 重连机制，仍需人工重连。

**14. 数据库迁移无 downgrade 路径**

这一条依然成立。  
当前策略主要是：

- integrity_check
- 损坏备份
- 从 `.bak` 恢复
- 失败后重建空库

对桌面工具来说这是合理取舍，但从严格迁移体系看，确实没有“回退到旧 schema 版本”的路径。

---

## 四、优先级建议

### P0

| # | 事项 | 现状 |
|---|------|------|
| 1 | 崩溃恢复链路闭环 | 读/写/UI 已接；恢复后「一键贴回画布」仍可增强 |
| 2 | 工具失败语义统一 | `{ok:false}`→`isError` 已落地（registry）；OpenAI 路径 is_error 映射仍弱 |
| 3 | 渲染层关键路径测试补强 | CrashRecovery / orchestra 有测；页面级仍薄 |

### P1

| # | 事项 | 现状 |
|---|------|------|
| 4 | LLM 协议适配层 | OpenAI 协议已接；Gemini 等仍缺；`custom`=Anthropic 兼容 |
| 5 | 错误与文案 i18n 收口 | `normalizeI18nKey` + errors 资源已补；IPC 迁移未 100% |
| 6 | Context window 管理升级 | 仍以简单截断为主，缺 token 预算与 compaction |
| 7 | Token 使用量产品化 | 已有 usage 日志，但没有持久化、展示和成本估算 |
| 8 | Windows 包验证 | mac 已验证，win 仍未真实闭环 |

### P2

| # | 事项 | 现状 |
|---|------|------|
| 9 | `ipc/home.ts` 拆分 | 单文件职责偏重，维护压力较大 |
| 10 | 结构化日志体系 | 现有 trace 风格日志较多，但未形成统一观测体系 |
| 11 | Diamond 图重复消息处理 | 当前明确接受该行为，复杂图可能放大 |
| 12 | MCP 自动重连 | 断线后仅自动卸载工具，不会自动恢复连接 |
| 13 | 浏览器自动化工具 | `browser_use` 仍未落地 |
| 14 | Markdown 渲染进一步硬化 | 不是已知高危缺口，但仍可收紧 link/url 策略 |

---

## 五、总体评价

**评分：8/10**

这是一个**架构质量明显高于一般桌面 AI 工具**的项目。  
它最强的部分不是 UI，而是后端执行与运行时语义：自研 Pregel 编排、GroupChat/Handoff 语义保真、Skill ContextProvider、MCP 集成、Registry 共享闭环，这些都说明项目已经越过了“demo 阶段”。

但它当前最真实的缺口也很清楚：

- 仍有少量“最后一公里”闭环没接完，尤其是 crash recovery
- 错误/i18n/工具失败语义还有一些不一致
- 渲染层测试强度和产品化观测能力还不够

如果这是一个个人项目继续迭代，当前的代码质量和架构已经是非常好的基础。  
如果要作为稳定分发产品，优先补齐的不是大重构，而是几条最影响体验和稳定性的收口项：**crash recovery、工具错误语义、i18n 尾巴、关键页面测试、provider 协议层**。
