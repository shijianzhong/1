# Beautiful UI 接入评估与建议

**结论：可以引用，但应采用"按组件取视觉与局部交互、按现有事件模型重写"的方式，而不是安装一个整包或整体替换当前界面。同时，应以"AI 回复去气泡"作为视觉基调，在此之上叠加 Beautiful UI 的组件设计。**

Beautiful UI 是面向 AI-native interface 的一组可复制 React UI primitives，官网示例提供 `View code`/`Copy code`，并公开以 MIT License 许可。其许可允许免费使用、修改、分发和商用；复制的代码或实质部分必须保留版权与许可声明。[1] [2] 当前 ONE 同样采用 MIT 许可，并使用 React 19、TypeScript、Tailwind CSS 4、Lucide、Radix 与 CSS Variables，技术上具备良好的接入基础。[3]

> 最合适的策略不是"把 Beautiful UI 搬进来"，而是将其作为 **AI 交互设计语言与可复用 TSX 起点**：保留 ONE 已经正确的 IPC、审批、编排流和数据模型，只替换呈现层，并为新增视图补齐状态与可访问性测试。

---

## 一、已核实的来源与许可

Beautiful UI 官网将组件定位为"Crafted primitives for AI-native interfaces"，展示了 Loading State、Thinking、Streaming Text、Approval Card、Tool Chips、Task Rows、Chat、Prompt Bar、Recommendation Card、Context Cards、表格、Search、Insight Cards、Code Block 等 19 类交互模块。[1]

官网的代码弹窗显示，其示例为可复制的 React/TSX 组件。已核验的 `LoadingState.tsx` 与 `ApprovalCard.tsx` 均使用 React hooks；示例带有 `"use client"`，并使用一组站点私有 Tailwind/token 类，例如 `bg-surface`、`text-ink`、`rounded-card`、`rounded-control`。这意味着它们更像 **copy-paste component collection**，而不是当前可直接安装、版本化升级的 npm 包。[1]

| 项目 | 核验结果 | 对 ONE 的含义 |
|---|---|---|
| 授权 | MIT，版权为 `Copyright (c) 2026 Shane Levine` | 可商用与改造；应保留版权、许可文本和来源记录。 [2] |
| 技术风格 | React hooks + TSX + Tailwind utilities + 自定义设计 token | React 逻辑可适配；视觉 class 不能直接粘贴。 |
| 发布形态 | 官网代码示例，不是经本次核验确认的包管理器组件库 | 不应新增加未知依赖；将选中的源码内置并由本项目维护。 |
| 当前项目 | React 19、TypeScript、Tailwind 4、Lucide、Radix、CSS Variables | 框架兼容度高，主要工作是 token 映射和状态接口适配。 [3] |

---

## 二、代码实查：ONE 前端组件全量清单与对应矩阵

基于对 `src/renderer/` 全量代码实查，下表列出 Beautiful UI 的 19 个组件与 ONE 现有前端的逐一对应关系，按优先级分三档。

### 第一档 · 高优先级（新建 / 重写，填补核心缺口）

| Beautiful UI 组件 | ONE 现状（代码实查） | 建议动作 | 工作量 | 关键改动点 |
|---|---|---|---|---|
| **Tool Chips** | 完全缺失。`reducer.ts` 中 `tool_call`/`tool_result` 仅切换 orbState（`searching`↔`working`），用户看不到工具调用过程。仅在 `approvalMode:'always'` 时通过 ApprovalCard 以 JSON 展示入参 | 新建 | M | reducer 扩展 + `ToolActivityChips` 组件 + CSS |
| **Thinking 增強** | `ThinkingBlock.tsx` 仅 27 行简单折叠（灰色 `border-left` + `opacity:0.55`），无分步骤/推理/搜索/编码分类。后端流事件 `thinking` 推送纯文本 | 重写 | M | 后端不改，前端升级为层次化 trace 容器 |
| **Streaming Text 增強** | `MessageItem`（148 行）+ `Markdown.tsx`（83 行）已有流式 markdown 渲染，缺 inline sources 引用和 follow-ups 后续建议 | 增强 | L | 后端事件扩展 + 来源芯片 + 跟进按钮 |
| **Task Rows** | `TasksPage.tsx` 71 行简单卡片网格，从 SQLite 读取历史任务，无实时状态流、无进度展示、无子任务层级 | 重写 | M | `WorkflowTaskList` 组件 + 实时状态订阅 |
| **Prompt Bar 增強** | `MentionComposer.tsx` 494 行已有完善 @提及（contenteditable + 芯片 + IME + 键盘导航），缺 /命令和运行时 model picker | 扩展 | M | 复用 @框架加 /触发器 + 模型下拉 |

### 第二档 · 中优先级（增强 / 新建）

| Beautiful UI 组件 | ONE 现状（代码实查） | 建议动作 | 工作量 | 关键改动点 |
|---|---|---|---|---|
| **Code Block 增強** | `Markdown.tsx` 代码高亮已有（rehype-highlight），缺逐行流式动画、语言标签和行号 | 增强 | S | 自定义 `pre` 渲染器 + 行号 + 工具栏 |
| **Approval Card 升級** | `ApprovalCard.tsx` 111 行已有完整功能（pending/approved/denied/expired + IPC respond），视觉可优化 | 美化 | S | CSS 升级 + 入参折叠展示 |
| **Search 命令面板** | 无全局搜索/命令面板。仅 `RegistryPage` 内嵌搜索 + `MentionComposer` @提及过滤 | 新建 | L | `Cmd+K` 触发 + 实时过滤 + 空状态 |
| **Context Cards** | 无。可配合三级记忆系统 L2/L3 检索结果展示 | 新建 | M | 记忆检索结果卡片化 + 来源标签 |
| **Selection Actions** | 无。高亮文本交 agent 重写功能 | 新建 | M | 文本选区监听 + 浮动操作条 + IPC |

### 第三档 · 不推荐替换（已有更好实现或场景不匹配）

| Beautiful UI 组件 | 不推荐原因（代码实查依据） |
|---|---|
| **Loading State** | ThinkingOrb Canvas 动画（9 状态 × 手调参数 × DPR 适配 × IntersectionObserver 离屏暂停），远优于像素网格，是项目特色 |
| **Sidebar Nav** | `AppShell.tsx` 229 行已有完整 icon-rail + 会话侧栏 + 动态 grid 布局 + `useChatStore` 集成，功能覆盖 |
| **Chat** | 已有完整实现：MessageItem 气泡 + orchestra reducer + 双场景共用（HomePage + RunChatPanel） |
| **Records / Filter / Diff Table** | 三种表格场景为 CRM/数据分析，与 AI Agent 编排桌面工具定位不匹配。ONE 的 Table 基础组件仅 ListPage 用过一次 |
| **Fine-tune / Insight / Recommendation** | 设计属性调试/数据洞察/推荐场景与当前编排引擎方向不匹配。Recommendation Card 可后置用于创建提案置信度展示 |

### ONE 前端关键架构事实（代码实查结论）

| 维度 | 实现方式 |
|------|---------|
| 状态管理 | 会话级 Zustand（`store/chat.ts`）；流式消息组件本地 `useState` + 纯函数 reducer（`orchestra/reducer.ts`） |
| 流式协议 | `window.one.home.onStream` IPC 回调，delta 类型：thinking/text/retry/error/orch_event/message_stop/proposal/proposal_error/create_notice |
| 渲染共用 | HomePage 与 EditorPage 运行面板共享同一 `ChatMessage` 模型 + `MessageItem` 气泡 + `applyOrchEvent` reducer |
| CSS 方案 | 全局 CSS（`app.css` ~1811 行 + `theme.css` ~259 行）+ CSS 变量（`--color-*`）+ BEM 类名；部分内联 style；编辑器面板混用 Tailwind className |
| 懒加载 | Markdown（react-markdown+katex ~1.2MB）用 `React.lazy` 按需加载 |
| thinking 解析 | 后端完成，前端只接收 `thinking` 文本字段 + 渲染折叠块 + Canvas 动画 |
| 工具调用 UI | **无**。reducer 中 tool_call/tool_result 仅切换 orbState，不展示工具名/入参/返回值 |

---

## 三、截图设计分析：无气泡 AI 回复的清爽方案

基于对参考截图（`20260813135631.jpg`）的视觉分析，提取可借鉴的设计策略。

### 截图设计核心特征

| 维度 | 截图设计 | ONE 当前实现 | 差异 |
|------|---------|-------------|------|
| AI 回复 | **无气泡**，直接铺在背景上，左对齐 | `.message__bubble--assistant` 有实色背景（`--color-bg-1`）+ 固定宽度 `min(85%, 680px)` | **核心差异**：截图更轻，ONE 更重 |
| 用户消息 | 白色圆角气泡，右对齐 | 动态 max-width 气泡，右对齐 | 基本一致 |
| 代码块 | 浅灰背景 + 行号 + 工具栏（复制/下载/展开） | `--color-bg-2` 实色无边框圆角 | 截图多了行号和工具栏 |
| 输入框 | 大圆角卡片 + 附件/技能/自动授权/token计数/模型选择 | MentionComposer contenteditable + 发送按钮 | 截图功能更显性 |
| 整体色调 | 极简灰白，零品牌色 | 纯白通透玻璃态 + brand 色点缀 | 截图更克制 |
| 消息间距 | 大间距分组（~32px） | CSS keyframes 入场动画 | 截图更疏朗 |

### 设计语义：差异化气泡策略

截图采用"用户消息有气泡、AI 回复无气泡"的差异化处理，这不是随意的视觉选择，而是有明确的设计语义：

- **用户消息 = 原子化输入单元**（需要边界确认，暗示"已发送、不可变"）
- **AI 回复 = 有机化内容画布**（需要灵活扩展，暗示"开放、可交互、可生长"）

这种策略让 AI 回复中的代码块、表格、列表等富元素自然嵌在透明背景上，不需要"气泡套气泡"的嵌套容器，视觉层次更清晰。

### AI 回复去气泡的具体 CSS 方案

改动量极小，主要是 `app.css` 中 `.message__bubble--assistant` 的几行样式调整：

```css
/* 改前 */
.message__bubble--assistant {
    background: var(--color-bg-1);
    border: 1px solid var(--color-border);
    padding: var(--spacer-12) var(--spacer-16);
    border-radius: var(--radius-card);
    width: min(85%, 680px);
}

/* 改后 */
.message__bubble--assistant {
    background: transparent;
    border: none;
    padding: 0;
    border-radius: 0;
    width: min(90%, 720px);
}
```

用户气泡保持不变（白色圆角气泡右对齐），形成视觉对比。

### 铁律冲突分析与调整建议

项目记忆中记录了一条铁律："Chat bubbles (content containers) must use solid background `--color-bg-1`, not glass effect"。

这条铁律的初衷是避免玻璃态（glass effect）导致文字可读性问题。去气泡方案是**完全透明背景**（不是玻璃态），文字直接在页面底色上，可读性反而更好。因此建议将铁律调整为：

> AI 回复消息采用透明背景（无气泡），用户消息保留实色气泡。禁止在消息容器上使用玻璃态（glass effect）效果。代码块、表格等富元素自带 `--color-bg-2` 实色背景，嵌在透明 AI 回复区上自然分层。

### 与 Beautiful UI 风格的融合

截图设计实际上是 Beautiful UI 风格的**更克制版本"。建议的融合策略：

- 以截图的"无气泡 AI 回复"作为**视觉基调**
- 在此基础上叠加 Beautiful UI 的 Tool Chips、ThinkingTrace 等组件
- 代码块借鉴截图的行号 + 工具栏设计（与 Beautiful UI 的 Code Block 组件合并实现）
- 输入框借鉴截图的功能显性化布局（与 Beautiful UI 的 Prompt Bar 合并实现，保留 MentionComposer 内核）

### 字体排版优化：松弛舒适的阅读节奏

截图的字体排版风格可概括为**"松弛的现代人文主义"**——系统字体栈 + 大行高 + 轻字重 + 克制的字号层级，营造 Notion/Linear/Claude 式的阅读舒适感。ONE 当前字体设置偏紧凑、字重偏重、字号碎片化，需向截图风格靠拢。

#### 对比分析

| 维度 | 截图设计 | ONE 当前实现 | 差异评估 |
|------|---------|-------------|---------|
| 字体族（中文） | PingFang SC 系统栈 | `"PingFang SC", "Inter", "Noto Sans SC", system-ui, sans-serif` | 基本一致，保持 |
| 字体族（代码） | Menlo/Monaco 系统栈 | `"JetBrains Mono", "SF Mono", "Cascadia Code", monospace` | ONE 更好（JetBrains Mono），保持 |
| 正文字号 | 14px | `0.875rem` (14px) | 一致 |
| **正文行高** | **1.6 - 1.75**（松弛舒适） | 1.4 - 1.5（偏紧凑） | **核心差异，需提升** |
| 代码字号 | 13px | 13px | 一致 |
| 代码行高 | 1.5 | 1.45 | 接近，微调到 1.5 |
| **最小字号** | 11px（时间戳/元信息） | 低至 `0.6rem` (9.6px) | **ONE 部分文字过小，需设下限 11px** |
| **字重风格** | 400 为主，500 强调，极少 600 | 400/500/600 混用，大量 600 | **ONE 偏重，600 降为 500** |
| 消息间距 | 24-32px 大留白 | 未统一 | 需规范到 24-32px |
| 段落间距 | 12-16px | 未统一 | 需规范 |
| 字间距 | 中文 0，英文 -0.01em | 部分元素 0.02-0.04em | 接近，保持 |
| 整体风格 | 松弛、轻盈、圆润 | 紧凑、偏重 | 需向截图靠拢 |

#### 核心问题

从 `app.css` 的 100 条字体相关 CSS 规则中看到，ONE 的字号使用非常分散：从 `0.6rem` (9.6px) 到 `1.5rem` (24px) 有十余种不同值。截图设计的克制感来自**统一的字号层级 + 松弛的行高 + 轻字重**，而 ONE 当前是"字号碎片化 + 行高偏紧 + 字重偏重"。

#### 具体调整方案

**1. 行高提升**（影响最大的单项改动）

```css
/* theme.css 新增排版变量 */
:root {
  --line-height-body: 1.65;      /* 正文行高，从 1.4-1.5 提升 */
  --line-height-code: 1.5;       /* 代码行高，从 1.45 微调 */
  --line-height-tight: 1.4;      /* 紧凑型行高（元信息/标签） */
}

/* app.css 中消息正文应用 */
.message__bubble {
  line-height: var(--line-height-body);
}
```

**2. 字号层级统一**（收敛为 5 档）

| 层级 | token | 值 | 用途 | One 当前最接近值 |
|------|-------|-----|------|-----------------|
| xs | `--text-xs` | 11px (`0.6875rem`) | 时间戳、token 计数 | `0.6rem`-`0.72rem` 碎片化 |
| sm | `--text-sm` | 12px (`0.75rem`) | 标签、Badge、元信息 | `0.75rem`-`0.8rem` 碎片化 |
| base | `--text-base` | 14px (`0.875rem`) | 正文、消息、输入框 | `0.875rem`（已一致） |
| lg | `--text-lg` | 16px (`1rem`) | 卡片标题、区域标题 | `1rem`（已一致） |
| xl | `--text-xl` | 18px (`1.125rem`) | 页面标题 | `1.5rem` 偏大，需缩小 |

```css
/* theme.css 新增 */
:root {
  --text-xs: 0.6875rem;   /* 11px，最小字号下限 */
  --text-sm: 0.75rem;     /* 12px */
  --text-base: 0.875rem;  /* 14px */
  --text-lg: 1rem;        /* 16px */
  --text-xl: 1.125rem;    /* 18px，从 1.5rem 缩小 */
}
```

后续逐步将 `app.css` 中的碎片化字号值（`0.6rem`/`0.68rem`/`0.7rem`/`0.72rem`/`0.76rem`/`0.78rem`/`0.8rem`/`0.82rem`/`0.84rem`/`0.85rem`/`0.86rem`/`0.88rem`/`0.9rem`/`0.92em`）收敛到上述 5 档 token。**最小字号不得低于 `--text-xs` (11px)**，当前低于 11px 的元素（`0.6rem` = 9.6px、`0.68rem` = 10.88px）需提升。

**3. 字重减轻**

将 `app.css` 中 `font-weight: 600` 的使用收敛为 `500`，仅在页面标题和强调按钮保留 `600`。截图的风格是"400 为主、500 强调、极少 600"，ONE 当前大量使用 600 导致视觉偏重。

**4. 消息间距与段落间距**

```css
/* 消息组间距：截图 24-32px，ONE 需加大 */
.message + .message {
  margin-top: 24px;  /* 从当前值提升 */
}

/* AI 回复内段落间距 */
.message__bubble--assistant p {
  margin-bottom: 12px;  /* 段落间距 */
}
.message__bubble--assistant p:last-child {
  margin-bottom: 0;
}

/* 段落与代码块之间 */
.message__bubble--assistant p + pre {
  margin-top: 16px;
}
```

**5. 字间距微调**

中文正文保持 `letter-spacing: 0`。英文正文可加微负字间距 `letter-spacing: -0.01em` 提升精致感。大写标签保持 `0.02em-0.04em`。

#### 落地策略

字体排版优化应与第一批改造同步进行，作为"视觉基调"的一部分：

- **第一周**：行高提升 + 字号 token 定义 + 消息间距调整（改动集中在 `theme.css` 和 `app.css` 的 `.message*` 选择器）
- **第二周**：字号碎片化收敛（逐步将 `app.css` 中的十余种字号值替换为 5 档 token）
- **第三周**：字重减轻（`600` → `500` 批量替换，保留标题级 `600`）

每步改动后需在 light/dark/warm 三主题下验证中英文混排可读性，特别注意代码块与正文的视觉层次。

---

## 四、哪些效果最值得优先引入

当前 ONE 已有 `MessageItem`、`ThinkingBlock`、`ApprovalCard`、`AskUserCard`、`MentionComposer`、编排流 reducer、工作流运行面板和任务/注册表页面。Beautiful UI 与 ONE 的重叠度很高，因此优先选择能让既有真实数据"更容易读"的组件，而不是展示性重做。[4] [5] [6]

| Beautiful UI 模块 | 与 ONE 的现有映射 | 建议 | 接入难度 | 原因 |
|---|---|---|---|---|
| **Tool Chips** | `StreamEvent.tool_call/tool_result` 已带 `tool`、`args`、`result`，但 reducer 目前只切换 orb 状态 | **第一优先**：增加折叠工具时间线/芯片 | 中 | 后端事件已经有数据，只差前端结构化呈现。 [7] |
| **Task Rows** | `node_started/node_done/node_error` 已存在，当前 reducer 不产生任务 UI | **第一优先**：为运行中编排加实时节点状态列表 | 中 | 让多 Agent 运行的过程可见，减少"卡住"的感受。 [7] |
| **Thinking** | ONE 有 `thinking: string` 与可折叠 `ThinkingBlock` | **第一优先**：升级为紧凑、可展开的 trace 容器 | 低 | 不改事件协议即可改善可读性；先做单一 trace，不强行伪造 Steps/Reasoning 分类。 [5] |
| **Approval Card** | ONE 已有真实审批事件、工具参数、批准/拒绝/过期状态 | **第一优先**：仅借鉴卡片层级、风险摘要、完成态动画 | 低 | 现有业务闭环完整，视觉替换风险最低。 [6] |
| **AI 回复去气泡** | ONE 的 `.message__bubble--assistant` 有实色背景 | **第一优先**：改为透明背景，用户气泡保留 | 低 | CSS 层面几行调整，效果显著，作为视觉基调 |
| **Loading State** | ONE 有 ThinkingOrb 和 `orbState` | **第二优先**：用作长耗时请求/执行器启动的可选微交互 | 低 | 可作为细节增强；不能取代明确的进度/取消信息。 [4] |
| **Streaming Text** | ONE 有 Markdown 流和发言人标签 | **第二优先**：优化流式游标、follow-up 和来源入口 | 中 | 其中 sources/follow-ups 需要新增数据模型，先只做无数据依赖的文字状态。 [4] |
| **Code Block** | ONE 有 Markdown 代码高亮，缺行号和工具栏 | **第二优先**：增加行号、语言标签、复制工具栏 | 低 | 与截图的代码块设计合并实现 |
| **Prompt Bar** | ONE 有功能复杂的 `MentionComposer` 和项目路径选择 | **暂缓整体替换**，借鉴布局 | 高 | 不应整体替换 `contentEditable`、提及和 IME 行为；可只借鉴布局、附件入口和 model picker 视觉。 [8] |
| **Recommendation Card** | ONE 有创建确认卡和 proposal card | **第二优先**：用于"创建能力/角色/Skill"的建议摘要 | 中 | 需保持现有确认语义与错误/重试链路，不可接管状态。 |
| **Context Cards / Sources** | 当前 `ChatMessage` 没有来源卡数据 | **后续** | 高 | 需要主进程将 web/file/tool 来源结构化下发。 [5] [7] |
| **Diff / Records / Filter tables** | ONE 有注册表、资产列表等管理页面 | **第三优先** | 中 | 有价值但不如 Agent 运行透明度优先；先抽共享 Table 状态和查询接口。 |
| **Sidebar Nav / Search** | ONE 已有 AppShell 和导航 | **只借鉴密度与搜索模式** | 中 | 整体替换收益低，可能破坏已有导航与 Electron 布局。 [9] |

---

## 五、不要直接复制或整体替换的部分

### 1. 不要直接替换审批组件的业务逻辑

Beautiful UI 的 Approval Card 示例通过组件内 `useState` 管理题目、选项、自动推进和"已发送"状态。ONE 的审批卡则收到真实 `approval_request` 后，经 `window.one.orchestrate.respond()` 将用户选择回传主进程，并由 `approval_resolved` 流事件定格状态。[6] [7]

因此，只能复用其**卡片层级、选项布局、进度反馈和完成动效**。实际审批的 `requestId`、工具名、入参、会话范围、提交中、失败和超时都必须继续由 ONE 的外部事件和 IPC 驱动。尤其不应因为视觉更简洁而隐藏工具参数或淡化"本会话允许"的风险提示。

### 2. 不要直接替换 Prompt Bar / MentionComposer

Beautiful UI 的 Prompt Bar 适合展示 @ source、命令、模型选择、附件和语音入口；ONE 当前的 `MentionComposer` 已经实现了 `contentEditable` 芯片、稳定 ID、中文 IME 防误发送、键盘导航和最近使用项。[8] 将其整体替换等同于重写一个复杂输入法/选择区组件，回归风险高。

正确方式是保留 `MentionComposer` 的 DOM 序列化与事件接口，用 Beautiful UI 的布局理念包裹它：把项目路径、模型选择、附件入口和发送按钮组织成更清晰的 Prompt Bar；在接口稳定后再逐步补可访问 combobox 语义和测试。

### 3. 不要直接使用官网的 token 类名

Beautiful UI 示例中的 `bg-surface`、`text-ink`、`rounded-card` 等不是 ONE 的 token。当前 ONE 使用 `--color-bg-*`、`--color-fg-*`、`--color-brand-*` 和自身的 Tailwind/CSS 组合。[3] 直接复制会导致无样式或引入第二套设计语言。

应先建立很薄的一层适配 token，例如 `--ai-surface`、`--ai-inset`、`--ai-border-subtle`、`--ai-text-muted`、`--ai-radius-card`、`--ai-radius-control`，再将它们映射到 ONE 既有 theme store 的颜色、密度和 dark/light 模式。这样 Beautiful UI 的视觉方向可以进入产品，同时不破坏用户主题配置。

### 4. 不要替换 ThinkingOrb

ThinkingOrb 是 ONE 的项目特色：单 `<canvas>` + `requestAnimationFrame` 自驱动渲染循环，9 种状态对应 9 种手调动画（working=粒子轨道 / searching=扫描经线地球 / solving=魔方翻转 / listening=波形 / connecting=星座连线 / weaving=三股辫 / composing=飘带 / breathing=呼吸环 / shaping=圆→三角→方变形），含 `IntersectionObserver` 离屏暂停、`prefers-reduced-motion` 降级、DPR 适配、三层主题探测。

Beautiful UI 的 Loading State（像素网格 shimmer）不应替换 ThinkingOrb。ThinkingOrb 应保留为 AI 思考状态的视觉指示器，ThinkingTrace 作为内容展开区与其联动。

---

## 六、推荐的第一批改造：五个组件，不改后端协议

第一批的目标是让 Agent 运行"可理解、可控、有质感"，并且尽量只改渲染层。建议顺序如下。

| 步骤 | 新/改组件 | 使用的现有数据 | 预期效果 | 改动文件与估算 | 必须测试 |
|---|---|---|---|---|---|
| 0 | **视觉基调：去气泡 + 字体排版** | 现有 `MessageItem` + CSS | AI 回复改透明背景；行高提升到 1.65；字号收敛 5 档 token；消息间距 24px | `app.css` 改 ~30 行（去气泡+间距）；`theme.css` +~15 行（行高/字号 token）；铁律文档更新 | dark/light/warm 三主题下中英文混排可读性；代码块与正文层次 |
| 1 | `ToolActivityChips` | `tool_call` 的 tool/args，`tool_result` 的 result | 将 currently only orb-state 的工具调用变成可折叠、带状态的紧凑 chip | `reducer.ts` +~40 行；新 `ToolActivityChips.tsx` ~80 行；`MessageItem.tsx` +~15 行；`app.css` +~60 行；`reducer.test.ts` 补测 | call → result、错误结果、长 args 截断、可访问标签 |
| 2 | `WorkflowTaskList` | `node_started/node_done/node_error` | 在 Home/RunChatPanel 显示"当前执行了谁、完成了谁、失败在哪"的任务行 | 新 `WorkflowTaskList.tsx` ~100 行；新 `RunActivityState` 类型 ~30 行；`reducer.ts` +~30 行；`app.css` +~50 行 | 并发节点、取消、失败、切换会话、done 后定格 |
| 3 | `ThinkingTrace` | `thinking` 文本、`thinkingCollapsed`、`orbState` | 以 Beautiful UI 的层次替换目前纯文本折叠块；突出耗时、展开/收起与流式态 | `ThinkingBlock.tsx` 27→~120 行；`app.css` 调整 | 流式追加、完成自动收起、键盘操作、reduced motion |
| 4 | `ApprovalCard` 视觉重构 | 原有 `ApprovalPrompt` 与 respond callback | 将风险、工具、参数摘要、拒绝/允许动作做成清晰的 HITL 卡片 | `ApprovalCard.tsx` CSS 为主 +~30 行；`app.css` +~40 行 | pending/submitting/success/denied/expired/error，且不得改变 IPC 语义 |

这五项能够直接使用当前事件类型。特别是 `StreamEvent` 已携带 `tool_call`、`tool_result`、`node_started`、`node_done`、`node_error`，只是 reducer 目前将工具事件压缩成 `orbState`，并忽略节点状态的聊天侧呈现。[7] 所以所需的首先是**扩展 ChatMessage/reducer 的表现模型**，而不是修改主进程编排协议。

### RunActivityState 分离架构

建议新增一个与 `ChatMessage` 分离的 `RunActivityState`，按 `runId` 或当前会话维护。不要继续把所有任务/工具状态塞进最后一条 assistant message，否则会放大此前审查发现的流式重渲染问题。活动列表可以是稳定的副栏/消息内折叠块，以 rAF 批量合并事件。

```typescript
// 新增类型，与 ChatMessage 分离
interface RunActivityState {
  runId: string;
  toolCalls: ToolCallInfo[];      // tool_call/tool_result 的结构化记录
  nodeStates: NodeStateInfo[];    // node_started/done/error 的状态行
  lastUpdated: number;
}

interface ToolCallInfo {
  id: string;
  tool: string;
  argsSummary: string;            // 截断 200 字符
  resultSummary?: string;         // 截断 200 字符
  status: 'pending' | 'done' | 'error';
  timestamp: number;
}

interface NodeStateInfo {
  nodeId: string;                 // executor_id == agent name == ReactFlow 节点 id
  status: 'running' | 'done' | 'error';
  startedAt: number;
  endedAt?: number;
  error?: string;
}
```

---

## 七、建议的第二批与后续能力

### 第二批（需扩数据模型，先完成第一批和流式性能治理）

| 组件 | 核心思路 | 改动文件与估算 |
|------|---------|---------------|
| **Streaming Text 流式游标优化** | 先做无数据依赖部分：优化流式游标动效、消息间距分组 | `MessageItem.tsx` +~20 行；`app.css` 调整 |
| **Code Block 增強** | 自定义 `pre` 渲染器加语言标签 + 行号 + 复制工具栏，与截图代码块设计合并 | `Markdown.tsx` +~40 行；`app.css` +~30 行 |
| **Prompt Bar 视觉壳** | 保留 MentionComposer 内核，只迁移外部布局：项目路径、模型选择、附件入口组织成更清晰的 Prompt Bar | `MentionComposer.tsx` 不改；`HomePage.tsx` +~40 行布局重构 |
| **Recommendation Card** | 映射到 CreateConfirmCard 置信度展示，保持现有确认语义与错误/重试链路 | `CreateConfirmCard.tsx` +~30 行 |

Streaming Text 中的 source pill、inline citation、follow-up 需要 `ChatMessage` 增加来源与建议操作的结构化字段；不能从 Markdown 字符串猜测来源。

### 第三批（需后端协议扩展）

| 组件 | 核心思路 | 前置条件 |
|------|---------|---------|
| **Context Cards** | 配合 L3 `memory_recall`/`memory_search` 工具返回，渲染知识块卡片 + 来源标签 | 主进程将 web/file/tool 来源结构化下发 |
| **Search 命令面板** | `Cmd+K` 全局触发，搜索会话/Agent/Skill/Capability，实时过滤 + 空状态 | 定义统一搜索接口 |
| **Selection Actions** | 监听 `Selection` API，AI 回复区选中文本后浮动操作条（重写/解释/追问） | IPC 支持追问上下文传递 |
| **/命令** | 复用 MentionComposer @框架，新增 `/` 触发器注册命令列表 | 命令注册表设计 |
| **Diff Table / Records Table / Insight Cards** | 资产编辑、注册表管理、数据分析 | 先定义统一 metadata schema、分页/虚拟化和权限披露 |

否则界面会有"很像 Agent 产品"的展示，却无法准确反映真实数据来源与操作后果。

---

## 八、许可与工程接入规范

由于 Beautiful UI 使用 MIT License，复制代码时应在仓库中保留第三方通知。建议新增 `THIRD_PARTY_NOTICES.md`，记录来源 URL、组件名、获取日期、版权与完整 MIT 文本；对直接改造的组件文件头注明"Adapted from Beautiful UI, Copyright (c) 2026 Shane Levine, MIT License"。[2]

组件代码应人工审查后再进入仓库，不应通过运行网页脚本、复制整页 bundle 或引入未锁定依赖的方式接入。每个组件应被改写为 ONE 的 TypeScript 类型、i18n、theme token、共享 Button/Dialog、现有事件模型和 `prefers-reduced-motion` 规范。视觉效果也应以 Electron 的 CPU/GPU 预算为约束：动画必须可降级，流式页面不得为每个 token 创建重型动画节点。

### token 适配层规范

在 `theme.css` 的 `:root` 中新增 `--ai-*` 前缀的薄适配层，映射到 ONE 既有 theme store：

```css
:root {
  --ai-surface: var(--color-bg-1);
  --ai-inset: var(--color-bg-2);
  --ai-border-subtle: var(--color-border);
  --ai-text-muted: var(--color-fg-2);
  --ai-radius-card: var(--radius-card, 12px);
  --ai-radius-control: var(--radius, 8px);
}

/* dark/warm 主题自动继承，因为引用的是 CSS 变量 */
```

Beautiful UI 改造的组件统一使用 `--ai-*` token，不直接引用 `--color-*`，形成样式作用域隔离。

### 铁律调整

去气泡方案需要调整项目记忆中的铁律。原铁律：

> Chat bubbles (content containers) must use solid background `--color-bg-1`, not glass effect

调整为：

> AI 回复消息采用透明背景（无气泡），用户消息保留实色气泡。禁止在消息容器上使用玻璃态（glass effect）效果。代码块、表格等富元素自带 `--color-bg-2` 实色背景，嵌在透明 AI 回复区上自然分层。

---

## 九、可执行的落地计划

### 第一周：视觉基调 + 字体排版 + 工具透明度

| 天 | 任务 | 产出 |
|---|---|---|
| 1 | AI 回复去气泡 CSS 改造 + 铁律文档更新 + 三主题验证 | `app.css` 改动；截图对比 |
| 1 | 字体排版优化 Phase 1：行高提升（`--line-height-body: 1.65`）+ 字号 token 定义（`--text-xs/sm/base/lg/xl`）+ 消息间距调整（24px） | `theme.css` + `app.css` 的 `.message*` 选择器 |
| 1-2 | token 适配层 `--ai-*` 建立 | `theme.css` 新增 token |
| 2-4 | `ToolActivityChips` 组件 + reducer 扩展 + `RunActivityState` 类型 | 新组件 + reducer 测试 |
| 4-5 | `ThinkingTrace` 重写 | `ThinkingBlock.tsx` 升级 |

同时要为 tool/result 与 thinking flow 写 reducer 测试。

### 第二周：字号收敛 + 任务可见性 + 审批打磨

| 天 | 任务 | 产出 |
|---|---|---|
| 1-2 | 字体排版优化 Phase 2：字号碎片化收敛（十余种字号值 → 5 档 token）+ 字重减轻（600 → 500，保留标题级 600） | `app.css` 批量替换 |
| 2-4 | `WorkflowTaskList` 组件 + 实时节点状态 | 新组件 + E2E |
| 4-5 | `ApprovalCard` 视觉重构 | CSS 升级 + 入参折叠 |

在 Electron E2E 覆盖批准、拒绝、超时、取消、并发节点与失败状态。此阶段应验证键盘焦点、读屏名称、reduced motion 和 light/dark/custom theme，而不是只看截图。

### 第三周：代码块 + Prompt Bar 视觉壳

| 天 | 任务 | 产出 |
|---|---|---|
| 1-2 | Code Block 增強（行号 + 语言标签 + 工具栏），与截图代码块设计合并 | `Markdown.tsx` 改动 |
| 3-5 | Prompt Bar 视觉壳（保留 MentionComposer 内核，只迁移外部布局） | `HomePage.tsx` 布局重构 |

保留现有 `MentionComposer` 内核，只迁移外部布局；在切换会话后项目目录重置、IME 发送、提及插入、取消流、重试等已有高风险路径全部通过后，再考虑显示 sources/contexts/diff 等需要扩充数据协议的模块。

### 第四周及后续：数据协议扩展

按第三批计划，根据实际需求排期 Context Cards、Search 命令面板、Selection Actions、/命令等需要后端协议扩展的组件。

---

## 参考资料

[1] [Beautiful UI 官网与组件目录](https://www.beautifului.dev/)

[2] [Beautiful UI MIT License](https://www.beautifului.dev/license)

[3] ONE 当前依赖与技术栈：`package.json`

[4] ONE 消息渲染：`src/renderer/src/components/orchestra/MessageItem.tsx`（148 行）

[5] ONE 聊天消息模型：`src/renderer/src/components/orchestra/types.ts`（72 行）

[6] ONE 审批卡：`src/renderer/src/components/orchestra/ApprovalCard.tsx`（111 行）

[7] ONE 编排流事件与 reducer：`src/shared/types.ts`；`src/renderer/src/components/orchestra/reducer.ts`（197 行）

[8] ONE 提及输入：`src/renderer/src/components/MentionComposer.tsx`（494 行）

[9] ONE 应用外壳：`src/renderer/src/layouts/AppShell.tsx`（229 行）

[10] ONE 思考球动画：`src/renderer/src/components/ThinkingOrb/`（117 行 + presets/theme/types/engine 子系统）

[11] ONE Markdown 渲染：`src/renderer/src/components/Markdown.tsx`（83 行）

[12] ONE 应用主样式：`src/renderer/src/styles/app.css`（~1811 行）；`src/renderer/src/styles/theme.css`（~259 行）

[13] ONE 任务页：`src/renderer/src/pages/TasksPage.tsx`（71 行）

[14] 参考截图：`20260813135631.jpg`（无气泡 AI 回复清爽设计参考）
