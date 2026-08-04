# ONE 桌面应用 — UI 质量审计报告

> 审计工具：UICraft（trae-remote-official:web-app-development）
> 审计日期：2026-08-04
> 审计范围：`src/renderer/src/` 全部页面、布局、样式文件

> **⚠ 二轮复核增补（2026-08-04，Cursor）**：本报告经 ui-ue-skill（web-ui 基础规则 + 视觉检查清单）、frontend-design、stitch-design-taste 三套镜头对代码事实复核。**§九 包含：3 处事实修正、P0 方向修正（对齐 DESIGN.md 既有规范而非新建令牌）、9 项审计盲区、反模式清单核查结果、修正后优先级总表 v2**。§六/§八 的优先级以 §九 v2 表为准。

---

## 一、评分卡

| 维度 | 分数 | 核心发现 |
|---|---|---|
| 可访问性 (A11y) | 2/4 | 命令面板缺键盘焦点态，部分按钮无 aria-label |
| 性能 | 3/4 | 动效已用 transform/opacity，少量组件缺 memo |
| 主题系统 | 2/4 | 颜色令牌完整，但间距/圆角/字号无令牌，页面全用内联硬编码值 |
| 响应式 | 2/4 | 零媒体查询，窗口缩小时 EditorPage 三栏挤压 |
| 反模式 | 2/4 | 4 份 EmptyState 重复，同一组件多种尺寸，非主观选择 |
| **总计** | **11/20** | **可接受，但系统性重复和令牌缺失拖了后腿** |

**评级 band**：10-13 Acceptable（有实质性改进空间）

---

## 二、审计范围

| 文件 | 路径 | 行数 |
|---|---|---|
| AppShell | `layouts/AppShell.tsx` | 288 |
| HomePage | `pages/HomePage.tsx` | 272 |
| AgentsPage | `pages/AgentsPage.tsx` | 426 |
| CapabilitiesPage | `pages/CapabilitiesPage.tsx` | 226 |
| EditorPage | `pages/EditorPage.tsx` | 1669 |
| ListPage | `pages/ListPage.tsx` | 490 |
| RegistryPage | `pages/RegistryPage.tsx` | 655 |
| SettingsPage | `pages/SettingsPage.tsx` | 441 |
| SkillsPage | `pages/SkillsPage.tsx` | 384 |
| TasksPage | `pages/TasksPage.tsx` | 82 |
| app.css | `styles/app.css` | 1460 |
| theme.css | `styles/theme.css` | 213 |

CSS 文件共 2 个：`app.css`（布局 + 组件类）和 `theme.css`（设计令牌 + Tailwind v4 入口）。项目使用 Tailwind CSS v4，UI 组件（Button/Input/Drawer 等）用 Tailwind 工具类 + CVA，但**页面层几乎全用内联样式**。

---

## 三、主题/令牌系统分析

### 3.1 现有令牌（theme.css）

**优点：**
- 定义了完整的三套主题（`:root` 默认 / `:root.dark` / `:root.warm`）
- 色彩层级清晰：`--color-bg-0/1/2/3`、`--color-fg-1/2/3`、`--color-brand-300/400/500/600`
- 玻璃系统完整：`--glass-bg`、`--glass-blur`、`--glass-shadow`、`--glass-border-top/bottom`
- 阴影三级：`--shadow-1/2/3`
- 支持动态缩放：`--density-scale`、`--font-scale`

### 3.2 令牌缺失

| 缺失令牌 | 影响 | 当前回退 |
|---|---|---|
| `--font-mono` | 代码块/技术文本无等宽字体令牌 | 回退到浏览器默认 `monospace`（ListPage L337、SkillsPage L355、RegistryPage L592） |
| `--r-xl` / `--r-lg` | 圆角令牌未定义 | app.css ReactFlow 节点回退到硬编码 `14px`/`12px`（L923/L984） |
| 间距令牌 `--space-*` | 无统一间距系统 | 所有 padding/gap/margin 硬编码像素值 |
| 圆角令牌 `--radius-*` | 无统一圆角系统 | 出现 4/6/8/10/12/14/16/18/20/24/999 共十余种值 |
| 字号令牌 `--text-*` | 无统一字号系统 | 出现 0.6 到 1.5rem 共 15+ 种值 |

### 3.3 令牌定义但未消费

- `--density-scale`：`theme.ts` 中定义了 `comfortable(0.85)/compact(1)/spacious(1.15)` 三档密度，写入 CSS 变量，但 **app.css 中没有任何地方使用它**——密度切换对界面完全无效。
- `--font-scale`：同理定义但未消费。

### 3.4 暗色/暖色主题缺口

- `:root.dark` 仅覆盖了 bg/fg/border/glass，**缺少 `--color-success`/`--color-warning`/`--color-danger`/`--color-info`/`--color-accent`/`--color-on-brand` 显式定义**。
- `:root.warm` 缺少上述语义色覆盖，以及 `--glass-blur`/`--overlay-bg` 等变量。

---

## 四、跨文件系统性问题

### 4.1 重复代码（DRY 违规）

| 重复项 | 出现位置 | 份数 | 说明 |
|---|---|---|---|
| `EmptyState` 组件 | AgentsPage, CapabilitiesPage, ListPage, SkillsPage | 4 | 代码完全相同 |
| `Field` 组件 | AgentsPage, ListPage, SkillsPage | 3 | 逻辑相同，SkillsPage 多了 `style` 参数 |
| `textareaStyle` 常量 | AgentsPage(140), ListPage(120), SkillsPage(120+200), EditorPage(80) | 4 | minHeight 各不相同 |
| `selectStyle` 常量 | ListPage, EditorPage, SettingsPage | 3 | borderRadius/padding 各不同 |
| 页面工具条模式 | Agents/Capabilities/List/Skills/Registry/Tasks | 6 | 相同内联：`padding:16, borderRadius:20, flex, space-between` |
| 空状态大按钮模式 | Agents/Capabilities/Skills | 3 | 几乎相同内联 |
| 卡片头像块 | Agents/Skills/Registry | 3 | `36x36, borderRadius:10, bg-3` 完全相同 |
| 技能 toggle 按钮 | AgentsPage, EditorPage | 2 | 尺寸不一致（0.78rem vs 0.72rem，padding 不同） |
| 卡片底部操作栏 | Agents/Capabilities/List/Skills/Registry | 5 | `flex, borderTop, paddingTop:10, marginTop:14` 相同模式 |

### 4.2 硬编码值清单

**圆角值（应建立 `--radius-*` 令牌）：**

| 值 | 用途 | 出现次数 |
|---|---|---|
| 4 | 小图标按钮 | 少量 |
| 6 | Badge 圆角 | 少量 |
| 8 | 小按钮/输入框 | 中等 |
| 10 | 头像块/select | 中等 |
| 12 | textarea/Input | 多处 |
| 14 | 面板内块 | 少量 |
| 16 | 工具条 padding | 多处 |
| 18 | 卡片圆角 | 5+ 处 |
| 20 | 工具条/空状态/section | 6+ 处 |
| 24 | TasksPage 工具条（不一致） | 1 处 |
| 999 | 胶囊按钮 | 少量 |

**间距值（应建立 `--space-*` 令牌）：**

| 类型 | 出现值 | 问题 |
|---|---|---|
| gap | 2, 4, 5, 6, 8, 10, 12, 14, 16, 20, 24 | 5/14 非 4 的倍数 |
| padding | 6, 8, 10, 12, 14, 16, 18, 20, 40, 48 | 14/18 非 4 的倍数 |

**字号值（应建立 `--text-*` 令牌）：**

| 值 | 用途 |
|---|---|
| 0.6rem | 入口徽章 |
| 0.68rem | 侧栏时间 |
| 0.7rem | Badge / thinking 标签 |
| 0.72rem | Inspector 标签 |
| 0.75rem | ID / 小文本 |
| 0.78rem | 技能 toggle / editor tab |
| 0.8rem | 指令预览 / 描述 |
| 0.82rem | 侧栏标题 |
| 0.84rem | create-card |
| 0.85rem | 运行按钮 |
| 0.86rem | Settings textarea |
| 0.875rem | section-title（CSS 定义值，但被多处覆盖） |
| 0.9rem | 部分标题覆盖 |
| 1rem | 工具条标题覆盖（6 处） |
| 1.5rem | welcome 标题 |

**maxWidth 值：**

| 值 | 用途 |
|---|---|
| 1200 | Agents/Capabilities/List/Skills/Registry 页面根容器 |
| 720 | SettingsPage |
| 440 | CapabilitiesPage Dialog |
| 640 | AppShell 命令面板 |
| 760 | chat-shell |

### 4.3 颜色使用问题

**硬编码非变量颜色：**
- EditorPage L1162：`rgba(120,130,145,0.12)` — ReactFlow Background，与 `--color-border` 的 `rgba(120,130,145,0.16)` alpha 不一致
- SettingsPage L28-34：`ACCENT_PRESETS` hex 数组 — 用户可选预设，可接受但应与 theme.ts 协调

**不存在的变量引用：**
- `--font-mono`（ListPage L337, SkillsPage L355, RegistryPage L592）
- `--color-brand-500-15`（AgentsPage L354，有 color-mix 回退）
- `--r-xl` / `--r-lg`（app.css L923/L984，有硬编码回退）

**brand-600 回退写法不统一：**
- RegistryPage L509：`'var(--color-brand-600, var(--color-brand-500))'` — 嵌套回退
- 其他地方直接用 `var(--color-brand-600)` 无回退

### 4.4 Hover/Focus/Active 状态缺失

| 组件 | 位置 | 缺失状态 |
|---|---|---|
| 技能 toggle 按钮 | AgentsPage L342, EditorPage L1531 | 无 hover 态 |
| Inspector 刷新按钮 | EditorPage L1438 | 无 hover 态 |
| RegistryPage 卡片 | L331 | 缺 `.asset-card` 类，无 hover |
| TasksPage 卡片 | L40 | 无 hover 态 |
| SettingsPage 预设卡 | L199 | 无 hover 态 |
| SettingsPage 点缀色按钮 | L237 | 无 hover 态 |
| EditorPage 返回按钮 | L1011 | 无 hover 态 |
| CapabilitiesPage 删除按钮 | L154 | 裸 `<button>`，无 hover |
| 命令面板列表项 | AppShell L246 | 无键盘 focus 态 |

### 4.5 布局模式不一致

| 模式 | 不一致表现 |
|---|---|
| 卡片网格 minmax | 260px（Capabilities, ListPage-skills）vs 280px（Agents, Skills, Registry） |
| Drawer 宽度 | 默认 600（Agents, Editor）vs 720（Skills）vs 640（Registry） |
| 文本截断 | `whiteSpace: nowrap`（Agents）vs `-webkit-box + lineClamp:2`（Skills, Registry） |
| 删除按钮 | `<Button variant="ghost" size="icon">`（Agents, Skills, List）vs 裸 `<button>`（Capabilities） |
| 工具条 borderRadius | 20（大部分）vs 24（TasksPage） |
| 标题 fontSize | CSS 定义 0.875rem，内联覆盖为 1rem（6 处）/0.9rem（SettingsPage） |

### 4.6 响应式问题

- **app.css 中零媒体查询** — 无任何 `@media` 断点
- 这是 Electron 桌面应用，移动端适配非必需，但**窗口缩放**无保护：
  - EditorPage 三栏（220px + flex + 340-760px）在窄窗口下挤压画布至不可用
  - SettingsPage `width: 220` 固定 Input 在窄窗口溢出
  - RegistryPage 搜索框 `width: 220` 固定，工具条 `flexWrap: 'wrap'` 是唯一防御
- `--density-scale` 令牌定义了但 CSS 中完全未消费，密度切换无效

### 4.7 排版不一致

- `body` 字体栈：`"PingFang SC", "Inter", "Noto Sans SC", system-ui, sans-serif`（theme.css L123）— 合理
- `--font-mono` 未定义，代码块/技术文本回退到浏览器默认 `monospace`
- `.section-title`（0.875rem/600）被内联覆盖为 0.9rem（SettingsPage）、1rem（Agents/Capabilities/List/Skills/Registry/Tasks）— CSS 类形同虚设
- `.section-subtitle`（0.875rem）也被多处内联覆盖

---

## 五、逐页面问题摘要

### 5.1 AppShell.tsx

- L103 内联 `gridTemplateColumns: '56px 220px minmax(0,1fr)'` 覆盖了 CSS `.app-shell` 的相同定义，两处需同步维护
- L195 Inspector `height: 'calc(100vh - 88px)'` — 88px 是 titlebar+padding 估算值，硬编码且脆弱
- L243-267 命令面板列表项用内联样式，已有 `.route-link` 类但被覆盖
- 命令面板列表项缺键盘 `:focus-visible` 态
- 侧栏删除按钮 `opacity: 0` 默认隐藏，可能影响屏幕阅读器发现

### 5.2 HomePage.tsx

- 几乎不用内联样式，依赖 CSS 类 — 是所有页面中最好的实践
- WelcomeScreen 用 emoji 作图标（`💬👥🧩🧠📁🌐`）— 不可主题化、不可缩放，与项目其他页面用 lucide-react 图标不一致
- L217 自动滚动阈值 `distance < 80` — 80px 魔法数字

### 5.3 AgentsPage.tsx

- 大量内联样式（工具条/卡片/表单全内联）
- L155 minmax(280px) — 与 CapabilitiesPage/ListPage 的 260px 不一致
- L342-360 技能 toggle 按钮 — 与 EditorPage 的同类按钮尺寸不同
- L354 `var(--color-brand-500-15, color-mix(...))` — 使用不存在的变量+回退
- L390 textareaStyle `minHeight: 140` — 与 ListPage 的 120 不一致

### 5.4 CapabilitiesPage.tsx

- L118 minmax(260px) — 与其他页面 280px 不一致
- L154 删除按钮用裸 `<button>` — 其他页面用 `<Button variant="ghost" size="icon">`，同一操作三种实现
- L78 标题 `fontSize: '1rem'` 覆盖 CSS `.section-title` 的 0.875rem

### 5.5 EditorPage.tsx（最复杂，1669 行）

- L996-1026 三栏布局全内联，220px Palette 固定宽度
- L1162 ReactFlow Background 硬编码 `rgba(120,130,145,0.12)`
- L1361-1414 NodeInspector 每个面板块都内联 `borderRadius:12, padding:12, gap:8` — 重复多次
- L1438 刷新按钮无 hover
- L1476 textarea `borderRadius:8` — 与其他页面 12 不一致
- L1531 技能 toggle 按钮 — 与 AgentsPage 的同类按钮尺寸不同
- L1659 selectStyle — 与 ListPage selectStyle 不一致
- L687 `TOLERANCE = 60` — 60px 容差魔法数字

### 5.6 ListPage.tsx

- L102 skills 卡片网格 minmax(260px) — 与其他页面 280px 不一致
- L175 TableHead `width: 100` 硬编码
- L383 selectStyle `borderRadius:12` — 与 EditorPage 的 10 不一致
- L430 textareaStyle `minHeight:120` — 与 AgentsPage 的 140 不一致

### 5.7 RegistryPage.tsx

- L334 卡片缺 `.asset-card` 类 — 无 hover 效果
- L224-234 搜索框图标用 absolute 定位 — 应抽成带 icon 的 Input 组件
- L370-406 Badge 内联 `fontSize: '0.7rem'` 出现 6+ 次
- L382-394 快速更新按钮 `height:22, width:22` — hack 式缩小 Button

### 5.8 SettingsPage.tsx

- 抽取了 `SectionCard`/`Row`/`SliderRow` 三个局部组件 — 比其他页面更好的组件化
- L132 Input `width: 220` 硬编码
- L150 selectStyle — 第三种 select 样式（borderRadius:12 vs ListPage 12 vs Editor 10）
- L174 textareaStyle — 第四种 textarea 样式（borderRadius:10 vs 其他 12/8）
- L209 预设卡片无 hover
- L241 点缀色按钮无 hover

### 5.9 SkillsPage.tsx

- 与 AgentsPage 模式高度重复
- L279 DrawerContent `width={720}` — 与 AgentsPage 默认 600 不一致
- L302 textarea `resize: 'none'` — 与其他 `resize: 'vertical'` 不一致
- L348 `fontFamily: 'var(--font-mono, monospace)'` — `--font-mono` 未定义

### 5.10 TasksPage.tsx

- 最简陋的页面，82 行
- L12 根容器无 `maxWidth` — 与所有其他页面不同
- L15 工具条 `borderRadius: 24` — 其他页面 20
- L38 用 `.placeholder-grid` CSS 类 — 其他页面用内联 grid
- 卡片无 hover 态
- 无 EmptyState 组件 — 与其他页面不一致

---

## 六、优先级建议

| 优先级 | 任务 | 工作量 | 影响范围 |
|---|---|---|---|
| **P0** | 定义间距/圆角/字号令牌（`--space-*`、`--radius-*`、`--text-*`） | 中 | 全局 |
| **P0** | 抽取 `EmptyState`、`Field`、`PageToolbar` 共享组件到 `components/ui/` | 中 | 6 个页面 |
| **P1** | 统一卡片网格 minmax 为 280px（或 `--card-min-width` 令牌） | 小 | 5 个页面 |
| **P1** | 统一文本截断为 `-webkit-box + lineClamp:2` | 小 | 3 个页面 |
| **P1** | 补齐 hover 态（RegistryPage/TasksPage/SettingsPage/EditorPage） | 小 | 4 个页面 |
| **P1** | 定义 `--font-mono` 和 `--r-xl`/`--r-lg` 令牌 | 小 | theme.css |
| **P2** | 消费 `--density-scale` 让密度切换生效 | 中 | app.css |
| **P2** | 统一 `selectStyle`/`textareaStyle` 为 FormSelect/FormTextarea 组件 | 中 | 4 个页面 |
| **P2** | EditorPage 窄窗口防御（min-width 或折叠逻辑） | 中 | EditorPage |
| **P3** | WelcomeScreen emoji 替换为 lucide-react 图标 | 小 | HomePage |
| **P3** | 统一 Drawer 宽度（或参数化） | 小 | 3 个页面 |
| **P3** | 暗色/暖色主题补全语义色定义 | 小 | theme.css |

---

## 七、已有良好实践

值得保留和推广的已有实践：

1. **HomePage 的 CSS 类驱动模式** — 几乎不用内联样式，依赖语义化的 `.chat-shell`/`.chat-messages`/`.composer` 类，是全项目最佳实践
2. **SettingsPage 的组件抽取** — 提取了 `SectionCard`/`Row`/`SliderRow` 局部组件，比其他页面更好的组件化
3. **颜色令牌系统** — `--color-bg-*`/`--color-fg-*`/`--color-brand-*` 三层色彩系统设计合理
4. **玻璃系统** — `--glass-bg`/`--glass-blur`/`--glass-shadow` 玻璃效果令牌完整
5. **`asset-card` CSS 类** — 最近新增的统一卡片 hover 动效类，已在 4 个页面使用
6. **侧栏删除按钮 hover 显隐** — `.side-list__item-delete` 的 `opacity:0 → hover:1` 模式，节省空间且交互清晰

---

## 八、建议的后续工作流

> 按优先级排序，P0 先行（**P0 的具体口径以 §九 v2 表为准——令牌是「落地 DESIGN.md 既有规范」而非「新建」**）：

1. **[P0] extract 工作流** — 提取共享组件（EmptyState/Field/PageToolbar/AssetCard），消除 5+3+6 份重复
2. **[P0] normalize 工作流** — 落地 DESIGN.md §四/§五/§3.1 既有令牌规范（`--spacing-*` rem 制 / `--radius-sm|md|lg|full` / 字号阶梯），density 经 `calc(base × var(--density-scale))` 同事件生效
3. **[P1] arrange 工作流** — 统一卡片网格 minmax、文本截断方式、Drawer 宽度
4. **[P1] polish 工作流** — 补齐所有缺失的 hover/focus 交互态 + `prefers-reduced-motion` 支持
5. **[P2] harden 工作流** — EditorPage 窗口缩放防御与结构拆分

> 修复完成后可重新运行 UICraft 审计验证改进效果。

---

## 九、二轮复核增补（2026-08-04，Cursor）

> 复核镜头：ui-ue-skill `web-ui`（视觉检查清单 + 间距/字体/色彩/对齐/适配基础规则）、`frontend-design`（反 AI 套路美学）、`stitch-design-taste`（反模式清单）。
> 不适用的镜头：`visual-screen-ui`（固定画布大屏，本项目非看板）、`algorithmic-art`/`canvas-design`（创作型 skill，无评审规则）。
> 复核方式：全部结论对代码事实 grep/抽查核验；**未运行 app 截图，视觉校验未执行**（见 §9.4 第 7 项的影响）。

### 9.1 事实修正（以上条目以本表为准）

| # | 原报告 | 代码事实 | 修正 |
|---|--------|---------|------|
| 1 | §3.3「`--font-scale` 同理定义但未消费」 | `theme.css:115` `html { font-size: calc(16px * var(--font-scale)) }` 已消费 | **仅 `--density-scale` 未消费**；且其未消费根因不是「app.css 没用」，而是 DESIGN.md §12.6 设计的机制是「density 乘到 `--spacing-*` 上」——`--spacing-*` 不存在，density 自然无处生效。令牌落地与 density 生效是同一件事，不应分设 P0+P2 |
| 2 | §4.1「EmptyState 4 份」 | `RegistryPage.tsx:637` 还有第 5 份（签名完全相同） | **5 份**（Agents/Capabilities/List/Skills/Registry） |
| 3 | §4.5 minmax 260 vs 280 | `app.css:181` `.placeholder-grid` 还有 **240px**（TasksPage 在用） | 三值并存 **240/260/280** |

### 9.2 P0 方向修正：对齐 DESIGN.md，不新建令牌

原报告 P0「定义 `--space-*`/`--radius-*`/`--text-*` 令牌」与项目既有设计规范冲突：

- `docs/DESIGN.md` **§四** 已定义 `--spacing-1/2/3/4/6/8`（**rem 制**、4px 步进、禁 5/7/10/13 怪值）；**§五** 已定义 `--radius-sm/md/lg/full`（6/8/12/9999，**仅 4 档**）；**§3.1** 已有字号阶梯
- 原报告发明的 `--space-*`（px 制）与 DESIGN.md `--spacing-*`（rem 制）是两套东西；px 间距不随 `fontScale` 缩放，DESIGN.md 用 rem 正是让 density × fontScale 可组合
- **正确表述**：P0 = 落地 DESIGN.md §四/§五/§3.1 既有规范；density 以 `--spacing-N: calc(<base> * var(--density-scale))` 消费
- **落地杠杆（原报告未提）**：项目是 Tailwind v4，令牌定义进 `@theme` 可让 Tailwind 工具类与 CSS 变量同源，一份定义两处消费
- **待设计决策**：DESIGN.md §五规定圆角仅 4 档（卡片 `radius-md` 8px），实现却是 18/20/24——是规范过时还是实现跑偏，需先决策再收敛（不要机械对齐任一方）

### 9.3 反模式清单核查结果（stitch-design-taste 逐条过）

| 规则 | 结果 | 代码事实 |
|------|------|---------|
| No emojis | ❌ | `HomePage.tsx:20-25` WelcomeScreen 6 个 emoji（与原报告 P3 交叉印证，建议优先级上调） |
| No pure black | ✅ | 仅 `rgba(0,0,0,α)` 玻璃阴影/遮罩（`theme.css:56-58,137`），合法深度用法 |
| No neon glow | ⚠ | `rf-pulse` 运行节点脉冲辉光（`app.css:1087-1089`）——功能性状态信号可辩护，但**无 reduced-motion 降级出口**（见盲区 1） |
| 过饱和 accent | ✅ | `ACCENT_PRESETS`（`SettingsPage.tsx:27-34`）中等饱和、用户自选；OKLCH 派生符合 T1 |
| transform/opacity only | ✅ | 原报告已确认 |
| 3 列均分卡片 | ✅ | 全用 `auto-fill minmax` |
| 通用转圈 loading | ✅ | 仅 `EditorPage.tsx:1116` 保存中图标内联 spin（瞬时状态非区域占位） |
| 触控/命中目标 | ⚠ | 快速更新按钮 22×22（`RegistryPage.tsx:382-394`）低于桌面可用下限 ~28px——原报告只说「hack 式缩小」，漏了命中区域角度 |
| 高密度数字等宽 | ⚠ | 时间戳/ID/token 计数未用 `tabular-nums`，并入 `--font-mono` 工作 |

### 9.4 审计盲区（原报告未覆盖的 9 项）

| # | 盲区 | 代码事实 | 建议 |
|---|------|---------|------|
| 1 | **`prefers-reduced-motion` 零支持** | 全渲染层零匹配；`rf-pulse`（`app.css:1073`）、`stream-blink`（:732）、`animate-spin`（`EditorPage.tsx:1116`）三个无限动画均无降级出口 | P1：加媒体查询兜底（无限动画 stilled/opacity 恒定），并作为未来入场动画的前置条件 |
| 2 | **z-index 层级无令牌** | 10/30/39/40/**9999** 裸值混用（`theme.css:132`、`app.css:10/580/1045/1220/1273`、`EditorPage.tsx:1181/1240`、`ContainerNodeView.tsx:172`） | P2：定义 `--z-base/dropdown/overlay/modal/toast` 层级令牌 |
| 3 | **对齐维度未系统审** | 仅提一次搜索框 absolute；图标底图/文本基线/数字右对齐未查 | P3：并入 polish 工作流抽查 |
| 4 | **a11y 只查皮毛** | 仅命令面板 focus + aria-label 两条；桌面键盘流（Escape/弹窗焦点陷阱）、玻璃底+背景图主题下文字**对比度**未查 | P2：键盘流与焦点陷阱审查；背景图主题下 fg 对比度抽查 |
| 5 | **EditorPage 1669 行结构问题** | 逐行问题列了，但根因是单文件巨型组件——NodeInspector/Palette/hooks 应拆文件；P2 窄窗口防御只是创可贴 | P2：结构拆分优先于窄窗口防御 |
| 6 | **动效 duration 无令牌 + `transition: all`** | duration 事实收敛于 100–200ms 但无令牌；`app.css:1198` `transition: all 120ms ease` 反模式（误动画布局属性） | P3：补 `--duration-fast/base` 两令牌；1198 改显式属性 |
| 7 | **品牌还原度未走查**（无法静态验证项） | 玻璃令牌存在 ≠ 玻璃效果可见（`backdrop-filter` 叠纯实色背景等于无效果）；「纯白通透玻璃态 + 清透少年感」是否达成无法静态判定 | P1：运行 app 截图对照 DESIGN.md 视觉承诺走查（人工+AI 联合），静态工具做不到 |
| 8 | **零入场动效编排** | 全 app 仅 2 个 keyframes 且都是功能状态；WelcomeScreen 是首屏 staggered reveal 的最佳落点，与 emoji→lucide 同区域可一次改完 | P2：WelcomeScreen reveal + 图标替换捆绑交付，**必须带 reduced-motion 降级** |
| 9 | **等宽字体性格** | `--font-mono` 缺失（原报告已列）；补时不应用浏览器默认 `monospace` 凑数 | P2：选 JetBrains Mono / Geist Mono 等性格等宽 + `tabular-nums`，一次解决令牌+时间戳/ID 数字对齐 |

### 9.5 修正后优先级总表 v2（替代 §六）

| 优先级 | 任务 | 备注 |
|---|---|---|
| **P0** | 落地 DESIGN.md §四/§五/§3.1 令牌（`--spacing-*` rem / `--radius-*` 4 档 / 字号阶梯），进 Tailwind v4 `@theme` 同源 | 含 density `calc` 消费（与原 P2 合并）；**先决策 radius 规范 vs 实现分歧** |
| **P0** | 抽取 `EmptyState`（**5 份**）、`Field`、`PageToolbar` 到 `components/ui/` | 原 P0 |
| **P1** | 品牌还原度走查（运行截图对照 DESIGN.md 玻璃态/清透感） | 盲区 7，人工+AI 联合 |
| **P1** | `prefers-reduced-motion` 支持（三个无限动画落点） | 盲区 1 |
| **P1** | 统一卡片网格 minmax（**240/260/280 三档收敛**）、文本截断、补齐 hover/focus | 原 P1 合并 |
| **P1** | WelcomeScreen emoji→lucide 图标（优先级自 P3 上调，反模式交叉印证） | 原 P3 + §9.3 |
| **P2** | `--font-mono`（性格等宽 + tabular-nums）、`--r-xl`/`--r-lg` | 原 P1 + 盲区 9 |
| **P2** | `selectStyle`/`textareaStyle` → FormSelect/FormTextarea 组件 | 原 P2 |
| **P2** | EditorPage 结构拆分（NodeInspector/Palette/hooks）→ 再做窄窗口防御 | 盲区 5，原 P2 升级 |
| **P2** | 键盘流/焦点陷阱/背景图主题对比度审查 | 盲区 4 |
| **P2** | z-index 层级令牌 | 盲区 2 |
| **P3** | WelcomeScreen staggered reveal（带 reduced-motion 降级） | 盲区 8 |
| **P3** | Drawer 宽度统一、暗色/暖色主题语义色补全 | 原 P3 |
| **P3** | `--duration-*` 令牌 + `transition:all` 改显式 + 命中区域 ≥28px | 盲区 3/6 + §9.3 |
