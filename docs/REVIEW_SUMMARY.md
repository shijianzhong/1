# One 项目文档 Review 汇总

> 本文档汇总对 `CLAUDE.md`、`REWRITE_PLAN.md`、`DESIGN.md`、`UI_BRIEF.md` 的 review 意见。
>
> **进度说明（2026-07-30）**：下文「可进入阶段 0」等结论为 **文档 review 当时** 的历史判断。脚手架与 M0–M3 / M5 骨架 / 部分 M6 已落地；**当前进度以根目录 [`task.md`](../task.md) 与 [`CLAUDE.md`](../CLAUDE.md)「当前阶段」为准**，勿再按本节末尾「进入阶段 0」执行。

---

## 一、上一次 Review 的修复情况

上次提出的 16 项问题中，**13 项已修复**，主要修复内容如下：

- CLAUDE.md 目录结构笔误已修正
- Framer Motion 重复行已删除
- 阶段编号从 0/1.5/1/2... 改为 0~7 连续编号，阶段 5（前端 UI）明确为并行阶段
- LLM key 加密闭环已补全（`secrets/vault.ts` + Node `crypto`，不走 `safeStorage`）
- 新增 §十「测试策略」（四层：单元/契约/集成/E2E + 覆盖率门槛）
- 新增 §十一「错误处理与崩溃恢复」（LLM/编排/IPC/存储/主进程崩溃/流式中断/草稿恢复）
- 新增 §十二「国际化（i18n）」（`react-i18next` + 命名空间懒加载 + `Intl` 格式化）
- Pregel superstep 模型在 builder 和 runner 中均有明确说明（非递归）
- `StreamEvent` 契约统一放到 `shared/types.ts`，作为前后端唯一契约源
- 背景图 IPC 从渲染层上传改为 `pickBackground()`（主进程 `dialog.showOpenDialog`）
- 暖白主题铁律补充了 HSL 限制（S≤15%，不算奶油/米色）
- 铁律从 23 条扩充为 24 条（新增 Skill = ContextProvider 定义）
- 路由表和 IPC 契约整理为 §八之二附录
- L0 个人档案来源明确为设置页"个人档案"分区

---

## 二、当前仍存在的问题

### 2.1 硬伤（必须改）

#### 1. UI_BRIEF §1 AI 气泡材质与 DESIGN.md 冲突

- **UI_BRIEF §1**："AI 气泡：左对齐，**磨砂玻璃面板**（`--glass-bg` + `--glass-blur`）"
- **DESIGN.md §9.1**："AI 气泡：左对齐，`bg-bg-1 border`"（实色）
- **DESIGN.md §2.3 铁律**："正文/代码/表格不要用 `--glass-bg`，用 `--color-bg-1`"

聊天气泡承载长文本 Markdown，是"内容"不是"框"。**UI_BRIEF 应改为实色 `--color-bg-1`**，与 DESIGN.md 和铁律保持一致。

#### 2. UI_BRIEF §6 命令面板背景色硬编码

第 89 行：`rgba(90,100,120,0.10)`

违反 DESIGN.md §2.3 "禁止硬编码 hex/rgb"铁律。建议改为 CSS 变量，如 `var(--color-bg-0)` 加透明度，或新增 `--overlay-bg` 变量。

#### 3. DESIGN.md §十三 交付清单重复

第 639 行与第 647 行内容重复：
- 639: "全部颜色走 token，无硬编码 hex/rgb"
- 647: "颜色全走 CSS 变量，无硬编码 hex/rgb（含玻璃元素走 `--glass-*`）"

建议合并为一条更完整的检查项。

#### 4. REWRITE_PLAN IPC 契约 `persona` 与目录结构不一致

- §八之二 B IPC 契约：`window.one.persona: { get, save }`（首页主助手人设）
- §七 目录结构：`main/ipc/` 下只有 `agents.ts` / `skills.ts` / `models.ts`，无 `persona.ts`
- §四 迁移映射表："人设并入角色或独立"（未明确）

**建议**：若并入 agents → IPC 中去掉 `persona` namespace，统一走 `agents`；若独立 → 补 `main/ipc/persona.ts` 并在阶段 1 任务中列出。

---

### 2.2 建议改

#### 5. 字体 fallback 顺序导致中文 FOUT

DESIGN.md §三：`"Inter", "PingFang SC", "Noto Sans SC", system-ui`

Inter 不含中文字形，浏览器先请求 Inter 渲染中文 → 字形缺失 → fallback 到 PingFang，产生 **FOUT**。

```css
/* 建议 */
--font-sans: "PingFang SC", "Inter", "Noto Sans SC", system-ui, sans-serif;
```

#### 6. UI_BRIEF 节点标签"二选一"与 i18n 策略不一致

- UI_BRIEF §实现约定第 4 条："节点标签可用中文或英文，**二选一全应用统一**"
- REWRITE_PLAN §十二.2："节点视觉标签可作为 i18n 资源，zh 用中文、en 用 SEQ/PAR/GROUP"

建议 UI_BRIEF 去掉"二选一"表述，统一为 i18n 策略。

#### 7. UI_BRIEF §0.1 SideList 展开态描述不完整

"仅'首页聊天'态展开，画布/管理态隐藏收回空间"——遗漏了设置页、任务进度页。建议改为"**仅首页聊天态展开，其它态均隐藏**收回空间"。

#### 8. ShadCN UI + Tailwind v4 兼容性风险未在风险表中提及

Tailwind v4 是重大重写（CSS-first configuration），ShadCN 默认模板仍基于 v3。建议在 §九 风险表增加一行：

| 风险 | 影响 | 对策 |
|---|---|---|
| ShadCN + Tailwind v4 兼容性 | 主题化/组件初始化可能需额外适配 | 先接入 v4，遇阻可 fallback 到 v3 |

#### 9. 背景图 dataURL 传输的性能/延迟

DESIGN.md §12.6.1 说压缩到 ≤ 2MB 后转 dataURL。2MB 图片 base64 后约 **2.7MB**，每次 IPC 传输这个 payload 有延迟。建议在 §12.6.1 边界约束中加一句：

> "背景图 dataURL 首次加载有传输延迟，大文件建议用 cover + 压缩到 ≤ 1MB 以控制 IPC payload 大小。"

#### 10. Electron 窗口标题栏/macOS traffic light 处理未提及

UI_BRIEF §0.1 说"顶部无固定栏"，但未说明 macOS traffic light（红绿黄按钮）如何处理、窗口拖动区域在哪里。Electron 通常需要 `titleBarStyle: 'hiddenInset'` 并指定 `-webkit-app-region: drag` 区域（如 IconRail 顶部）。建议在 UI_BRIEF §0.1 或 REWRITE_PLAN §六 中补一句窗口标题栏策略。

#### 11. Anthropic beta API 日期硬编码可能过时

REWRITE_PLAN §三之三 I 中 `betas` 数组写了具体日期：`["mcp-client-2025-04-04","code-execution-2025-08-25"]`。Anthropic beta 标签会随时间变化。建议加一句：

> "实现前查 Anthropic 官方文档确认当前 beta 标签；已转稳定的 API 改用稳定端点。"

#### 12. `@theme inline` 缺少 glass/shadow 变量注册

DESIGN.md §2.1 的 `@theme inline` 只注册了 `--color-*` 系列，没有注册 `--glass-*` / `--shadow-*`。虽然不影响功能（可通过 `var()` 直接使用），但如果想让 `bg-glass` 这类 Tailwind 工具类生效，需要注册。建议补充：

```css
@theme inline {
  /* ... 现有 color 变量 ... */
  --glass-bg: var(--glass-bg);
  --glass-bg-strong: var(--glass-bg-strong);
  --glass-blur: var(--glass-blur);
  --glass-blur-strong: var(--glass-blur-strong);
  --shadow-1: var(--shadow-1);
  --shadow-2: var(--shadow-2);
  --shadow-3: var(--shadow-3);
}
```

---

## 三、问题汇总表

| 类别 | 编号 | 问题 | 位置 | 优先级 |
|---|---|---|---|---|
| 硬伤 | 1 | AI 气泡材质冲突（玻璃 vs 实色） | UI_BRIEF §1 / DESIGN.md §9.1 | 高 |
| 硬伤 | 2 | 命令面板背景色硬编码 rgba | UI_BRIEF §6 | 高 |
| 硬伤 | 3 | 交付清单两条重复 | DESIGN.md §十三 | 中 |
| 硬伤 | 4 | persona namespace 与目录不一致 | REWRITE_PLAN §八之二 B / §七 | 中 |
| 建议 | 5 | 字体 fallback 顺序（Inter 在前） | DESIGN.md §三 | 低 |
| 建议 | 6 | 节点标签"二选一"与 i18n 冲突 | UI_BRIEF §实现约定 | 低 |
| 建议 | 7 | SideList 展开态描述不完整 | UI_BRIEF §0.1 | 低 |
| 建议 | 8 | ShadCN + Tailwind v4 风险未提及 | REWRITE_PLAN §九 | 中 |
| 建议 | 9 | 背景图 dataURL 性能未提及 | DESIGN.md §12.6.1 | 低 |
| 建议 | 10 | 窗口标题栏/traffic light 未提及 | UI_BRIEF §0.1 | 低 |
| 建议 | 11 | beta API 日期硬编码 | REWRITE_PLAN §三之三 I | 低 |
| 建议 | 12 | @theme inline 缺 glass/shadow | DESIGN.md §2.1 | 低 |

---

## 四、总体评价

文档经过两轮迭代后，**架构设计、技术选型、迁移策略、测试/错误/i18n 策略均已非常扎实**。特别是：

- §三之三对 Agent Framework 源码的深读梳理是亮点，Pregel superstep 模型和铁律约束保证了 TS 自研内核的行为等价性
- §十一错误恢复覆盖了从 LLM 调用到主进程崩溃的全链路
- §十二 i18n 方案务实（"从一开始做"），避免了后期 retrofit 的高昂成本

当前遗留问题（文档 review 当时）集中在**文档间一致性**与边界遗漏，**当时**结论是可进入阶段 0——**该结论已过时**（见文首进度说明）。

> **实现进度（2026-07-30）**：当前战场是 **M4 编排保真收口 + i18n 清零 + 首页组队路由 + Skill/工具深化**。权威勾选 → [`task.md`](../task.md)。

---

## 五、第三轮 Review（全量通读）

> 上一轮 12 项全部修复确认后，全量通读四份文档发现 5 处新问题，均已修复。

### 5.1 修复记录

| 编号 | 问题 | 位置 | 修复 |
|---|---|---|---|
| 13 | `--shadow-1/2/3` 在 §5 裸代码块中，无选择器包裹，`@theme inline` 引用时 `var()` 解析不到值 | DESIGN.md §5 / §2.1 | 三行 shadow 定义移入 §2.1 `:root` 块末尾（`--overlay-bg` 之后），§5 改为引用说明 |
| 14 | 代码块背景色冲突：DESIGN 用 `bg-bg-0`（与画布同色缺层次），UI_BRIEF 用 `--color-bg-2` | DESIGN.md §9.1 / UI_BRIEF §1 | DESIGN 统一为 `bg-bg-2` + 去掉 border，与 UI_BRIEF 一致 |
| 15 | 引用块左边框冲突：DESIGN 用 `border-border-strong`（中性灰），UI_BRIEF 用 `--brand-500`（品牌色） | DESIGN.md §9.1 / UI_BRIEF §1 | DESIGN 统一为 `border-brand-500`，与 UI_BRIEF 一致 |
| 16 | `:root.warm` 暖白主题 CSS 完全缺失（§十和 §12.4 引用 `warm` class 但无对应 CSS 规则） | DESIGN.md §2.1 | 补 `:root.warm { ... }` 完整变量覆盖块（暖白中性色阶 + 暖琥珀点缀色 + 暖调玻璃），与 `:root.dark` 同级 |
| 17 | Dialog/Drawer 背板用 `bg-bg-0/70`，命令面板已改用 `--overlay-bg` | DESIGN.md §8.4 | 保持现状——`bg-bg-0/70` 走的是 CSS 变量 + Tailwind alpha 修饰（非硬编码），且 Dialog 需 70% 遮罩强度 vs 命令面板 10% 极淡遮罩，二者需求不同，不强行统一 |

### 5.2 结论

三轮 review 后文档间一致性已对齐，CSS 变量定义链完整（`:root` 定义 → `:root.dark`/`:root.warm` 覆盖 → `@theme inline` 注册 → 组件引用），无架构级问题。~~可正式进入阶段 0 脚手架搭建。~~

> **已过时**：阶段 0 早已完成。本文档保留为「设计文档 review 档案」；**不要**据此判断实现进度。进度 → [`task.md`](../task.md)。
