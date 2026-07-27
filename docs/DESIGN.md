# One — UI 设计规范与风格指南

> 配套 [`REWRITE_PLAN.md`](./REWRITE_PLAN.md) §3.2 技术栈（ShadCN UI + Radix + Tailwind v4 + Lucide + Framer Motion）。
> 本文件是渲染层视觉与组件的唯一事实源。所有页面/组件按此实现，PR 以此为评审依据。

## 一、设计原则

1. **克制优先**：桌面 AI 编排工具，长时间凝视。少装饰、清透、高对比文字。视觉噪声 = 注意力税。
2. **纯白通透优先**（pure-white-first）：默认纯白通透玻璃态，干净即年轻。"清新阳光"靠纯白底 + 玻璃通透 + 一抹清透冷净点缀色实现，**不靠暖黄/米色**（屏幕上易显土）。深色为可选对等主题（跟随系统或手动）。
3. **内容为王**：编排画布与聊天流是主角，UI 框架（侧边栏/工具栏/抽屉）退到背景，不抢视觉权重。
4. **玻璃是框，实色是内容**：磨砂玻璃只做容器与悬浮层（导航/检视器/命令面板/Toast/输入框容器），正文/代码/表格用更厚实的实色承载，保证对比度与长时阅读舒适。
5. **状态可读**：每个元素都有清晰的 idle / hover / active / focus / disabled / loading / error 态，态变化用颜色+微动效，不只靠颜色（色盲友好）。
6. **密度可调**：画布编辑器要高密度（信息密集），聊天/设置要舒展（阅读优先）。一套 token，按场景调密度。
7. **动效有目的**：动效用来解释状态变化（进入/开合/进度），不做装饰。200~300ms，缓动统一。
8. **主题可自定义**：默认提供纯白通透/暖白/夜色几套预设，用户可改点缀色、调中性色、换背景图，主题配置存本地。详见 §十二主题系统。

## 二、色彩系统

> 默认纯白通透玻璃态（pure-white-first）。色彩通过 CSS 变量定义，运行时由主题系统（§十二）切换；下面是**默认主题**的令牌。

### 2.1 设计令牌（Tailwind v4 `@theme` + CSS 变量）

```css
/* renderer/src/styles/theme.css */
@import "tailwindcss";

/* 主题色统一用 :root 上的 CSS 变量定义，方便运行时切换
   （主题系统通过覆盖这些变量实现换肤，见 §十二） */
:root {
  /* —— 中性色阶（纯白通透，冷调不暖） —— */
  --color-bg-0: #FCFCFD;            /* 画布底（几乎纯白，一丝冷调） */
  --color-bg-1: #FFFFFF;            /* 实色卡片/正文底（最厚实） */
  --color-bg-2: #F4F6F8;            /* 次级实色底（代码块、表头） */
  --color-bg-3: #EBEEF2;            /* hover 态底 */
  --color-border: rgba(120,130,145,0.16);       /* 默认描边（冷灰） */
  --color-border-strong: rgba(120,130,145,0.28);/* 强调描边 */

  --color-fg-1: #1F2329;            /* 主文字（深墨灰，冷不暖） */
  --color-fg-2: #8A9099;            /* 次文字/说明 */
  --color-fg-3: #BCC2CB;            /* 占位/禁用 */

  /* —— 玻璃面板（悬浮层用，吸附背景模糊） —— */
  --glass-bg: rgba(255,255,255,0.60);
  --glass-bg-strong: rgba(255,255,255,0.78);
  --glass-border-top: rgba(255,255,255,0.95);     /* 顶部高光描边 */
  --glass-border-bottom: rgba(120,130,145,0.12);  /* 底部冷灰细描边 */
  --glass-shadow: 0 6px 20px rgba(90,100,120,0.06);
  --glass-blur: 16px;
  --glass-blur-strong: 24px;

  /* —— 点缀色（薄荷绿，清透少年感；可整体替换） —— */
  --color-brand-300: #7FE3D9;
  --color-brand-400: #4ECDC4;
  --color-brand-500: #3BB5AC;        /* 主操作、激活、focus ring */
  --color-brand-600: #2E9B93;

  /* —— 语义色（冷调，与点缀色同语言） —— */
  --color-success: #4CAF7D;
  --color-warning: #E0A93C;
  --color-danger:  #E15F5F;
  --color-info:    #5BA8E8;

  /* —— 弹层遮罩（命令面板/对话框/抽屉的背板） —— */
  --overlay-bg: rgba(90, 100, 120, 0.10);   /* 浅色主题默认 */

  /* —— 投影（极克制，深色下靠 bg-2 分层） —— */
  --shadow-1: 0 1px 2px oklch(0 0 0 / 0.2);            /* 卡片 */
  --shadow-2: 0 4px 12px oklch(0 0 0 / 0.25);          /* 悬浮菜单 */
  --shadow-3: 0 12px 32px oklch(0 0 0 / 0.35);         /* 弹层/抽屉 */
}

/* 夜色主题：覆盖同名变量（可选，跟随系统或手动） */
:root.dark {
  --color-bg-0: #0E1116;
  --color-bg-1: #15181F;
  --color-bg-2: #0F1115;
  --color-bg-3: #1C2029;
  --color-border: rgba(255,255,255,0.08);
  --color-border-strong: rgba(255,255,255,0.16);
  --color-fg-1: #E8ECEF;
  --color-fg-2: #9BA1AA;
  --color-fg-3: #5E6470;
  --glass-bg: rgba(20,22,28,0.60);
  --glass-bg-strong: rgba(20,22,28,0.80);
  --glass-border-top: rgba(255,255,255,0.08);
  --glass-border-bottom: rgba(0,0,0,0.4);
  --glass-shadow: 0 6px 20px rgba(0,0,0,0.35);
  --color-brand-300: #7FE3D9;
  --color-brand-400: #4ECDC4;
  --color-brand-500: #4ECDC4;  /* 夜色下略提亮 */
  --color-brand-600: #3BB5AC;
  --color-success: #5BCE8A;
  --color-warning: #E8C068;
  --color-danger:  #E8746F;
  --color-info:     #6FB8E8;
  --overlay-bg: rgba(0, 0, 0, 0.45);   /* 夜色主题弹层遮罩 */
}

/* 暖白主题：覆盖同名变量（可选，手动选择） */
:root.warm {
  /* —— 中性色阶（暖白，底色范围 #F9F6F0~#FBF8F1，HSL S≤15%）—— */
  --color-bg-0: #FBF8F1;            /* 画布底（暖白） */
  --color-bg-1: #FFFBF5;            /* 实色卡片/正文底（暖白厚实） */
  --color-bg-2: #F5F0E8;            /* 次级实色底（暖灰白） */
  --color-bg-3: #EBE5DA;            /* hover 态底（暖灰） */
  --color-border: rgba(140,120,90,0.16);        /* 默认描边（暖灰） */
  --color-border-strong: rgba(140,120,90,0.28); /* 强调描边 */

  --color-fg-1: #2A2520;            /* 主文字（深暖灰） */
  --color-fg-2: #9A8E80;            /* 次文字/说明（暖灰） */
  --color-fg-3: #C9BFB0;            /* 占位/禁用（淡暖灰） */

  /* —— 玻璃面板（暖调） —— */
  --glass-bg: rgba(255,252,248,0.60);
  --glass-bg-strong: rgba(255,252,248,0.78);
  --glass-border-top: rgba(255,255,255,0.95);
  --glass-border-bottom: rgba(140,120,90,0.12);
  --glass-shadow: 0 6px 20px rgba(140,120,90,0.06);
  --glass-blur: 16px;
  --glass-blur-strong: 24px;

  /* —— 点缀色（暖琥珀，可整体替换） —— */
  --color-brand-300: #E8B67A;
  --color-brand-400: #E0A059;
  --color-brand-500: #D98E3A;        /* 主操作、激活、focus ring */
  --color-brand-600: #C17B2E;

  /* —— 语义色（暖调对等） —— */
  --color-success: #4CAF7D;
  --color-warning: #E0A93C;
  --color-danger:  #E15F5F;
  --color-info:    #5BA8E8;

  /* —— 弹层遮罩（暖调） —— */
  --overlay-bg: rgba(140, 120, 90, 0.10);

  /* —— 投影（与纯白一致，中性阴影） —— */
  --shadow-1: 0 1px 2px oklch(0 0 0 / 0.2);
  --shadow-2: 0 4px 12px oklch(0 0 0 / 0.25);
  --shadow-3: 0 12px 32px oklch(0 0 0 / 0.35);
}

/* 让 Tailwind v4 的 bg-*/fg-*/border-* 工具类映射到上面变量 */
@theme inline {
  --color-bg-0: var(--color-bg-0);
  --color-bg-1: var(--color-bg-1);
  --color-bg-2: var(--color-bg-2);
  --color-bg-3: var(--color-bg-3);
  --color-border: var(--color-border);
  --color-border-strong: var(--color-border-strong);
  --color-fg-1: var(--color-fg-1);
  --color-fg-2: var(--color-fg-2);
  --color-fg-3: var(--color-fg-3);
  --color-brand-300: var(--color-brand-300);
  --color-brand-400: var(--color-brand-400);
  --color-brand-500: var(--color-brand-500);
  --color-brand-600: var(--color-brand-600);
  --color-success: var(--color-success);
  --color-warning: var(--color-warning);
  --color-danger:  var(--color-danger);
  --color-info:    var(--color-info);
  /* 玻璃/遮罩/投影也注册，让 bg-glass / shadow-1 等工具类可用 */
  --color-glass-bg: var(--glass-bg);
  --color-glass-bg-strong: var(--glass-bg-strong);
  --color-overlay-bg: var(--overlay-bg);
  --glass-blur: var(--glass-blur);
  --glass-blur-strong: var(--glass-blur-strong);
  --shadow-1: var(--shadow-1);
  --shadow-2: var(--shadow-2);
  --shadow-3: var(--shadow-3);
}
```

> **点缀色替换**：改 `--color-brand-*` 四个变量即可全局跟随。预设：薄荷绿 `#4ECDC4`（默认，清透少年感）、天空蓝 `#5BA8E8`、青柠 `#9BC53B`。
> **玻璃配方**：玻璃面板一律 `background: var(--glass-bg); backdrop-filter: blur(var(--glass-blur)); border-top: 1px solid var(--glass-border-top); border-bottom: 1px solid var(--glass-border-bottom); box-shadow: var(--glass-shadow);`。所有玻璃元素引用这些变量，主题切换时统一变。

### 2.2 语义令牌到组件映射

| 语义 | token | 用途 |
|---|---|---|
| 背景 | `bg-bg-0/1/2/3` | app 底/面板/弹层/hover |
| 文字 | `fg-fg-1/2/3` | 主/次/占位 |
| 描边 | `border-border` / `border-border-strong` | 默认/强调分隔 |
| 主操作 | `brand-500` | 主按钮、选中态、focus ring |
| 成功 | `success` | 完成、已就绪 |
| 警告 | `warning` | 轮次接近上限、配额告警 |
| 危险 | `danger` | 删除、失败、错误 |
| 信息 | `info` | 中性提示、链接 |

### 2.3 铁律

- **禁止用暖黄/奶油/米色作底**（屏幕上易显土）——纯白通透主题的中性色一律冷调（冷白/冷灰）。暖白主题是另一套预设（底色范围 `#F9F6F0~#FBF8F1`，HSL 中 S≤15%，属极淡暖白，不算违规；超出此范围算奶油/米色违规），不要和纯白混用。
- 禁止用纯黑 `#000` 作正文色（刺眼），用 `--color-fg-1`（深墨灰）。
- 禁止硬编码 hex/rgb，一律走 token；玻璃元素一律走 `--glass-*` 变量。
- 禁止用颜色作为唯一状态信号（加图标/文字/形状）。
- **玻璃是框，实色是内容**：正文/代码/表格不要用 `--glass-bg`，用 `--color-bg-1`（实色厚白）保证对比度。

## 三、字体系统

```css
@theme {
  /* 中文 fallback 在前：避免 Inter（无中文字形）先尝试渲染中文产生 FOUT */
  --font-sans: "PingFang SC", "Inter", "Noto Sans SC", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", "SF Mono", "Cascadia Code", monospace;
}
```

### 3.1 字号阶梯（桌面，rem）

| token | size | line-height | 用途 |
|---|---|---|---|
| `text-xs` | 0.75rem (12) | 1.5 | 标签、徽章、时间戳、画布节点角标 |
| `text-sm` | 0.875rem (14) | 1.5 | 表单、表格、次级说明、聊天 meta |
| `text-base` | 1rem (16) | 1.6 | 正文、聊天气泡、输入框 |
| `text-lg` | 1.125rem (18) | 1.5 | 区块标题、抽屉标题 |
| `text-xl` | 1.25rem (20) | 1.4 | 页面标题 |
| `text-2xl` | 1.5rem (24) | 1.3 | 空态大标题 |

- 字重：正文 400，标题 600，强调 500。不用 700（过粗，深色下糊）。
- 中文最小 12px，低于 12 不可读。
- 代码块一律 `font-mono` + `text-sm`。

## 四、间距 / 栅格

```css
@theme {
  --spacing-1: 0.25rem;   /* 4 */
  --spacing-2: 0.5rem;    /* 8 */
  --spacing-3: 0.75rem;   /* 12 */
  --spacing-4: 1rem;      /* 16 */
  --spacing-6: 1.5rem;    /* 24 */
  --spacing-8: 2rem;      /* 32 */
}
```

- **基础步进 4px**。所有间距是 4 的倍数，禁止 5/7/10/13 这类怪值。
- 组件内 padding：紧凑 8/12，舒适 16/24。
- 页面内容最大宽度：聊天流不限，管理表格 1200px 居中，设置页 720px。
- 画布节点：宽 240~280，高按内容自适应，最小 96。

## 五、圆角 / 描边 / 阴影

```css
@theme {
  --radius-sm: 0.375rem;   /* 6  —— 小元素、徽章、输入框 */
  --radius-md: 0.5rem;    /* 8  —— 按钮、卡片、气泡 */
  --radius-lg: 0.75rem;   /* 12 —— 弹层、抽屉、对话框 */
  --radius-full: 9999px;  /* 胶囊、头像 */
}
```

- 描边统一 `1px solid var(--color-border)`，hover 提到 `border-strong`，focus 用 `brand-500` 2px ring + 2px offset。
- 阴影极克制（深色下阴影几乎不可见，靠 `bg-2` 区分层级），令牌见 §2.1 `:root` 中的 `--shadow-1/2/3`。

## 六、动效

```css
@theme {
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);   /* 标准缓出 */
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
  --dur-1: 120ms;   /* hover/focus 即时反馈 */
  --dur-2: 200ms;   /* 开合、淡入 */
  --dur-3: 320ms;   /* 抽屉、大区域切换 */
}
```

- hover/focus：120ms `ease-out`
- 列表项进入：200ms，`opacity 0→1` + `translateY 4px→0`
- 抽屉/对话框开合：320ms `ease-in-out`，`translateX/Y` + opacity
- 流式 token 出现：无动效（直接出现，避免抖动），用**光标**（闪烁竖线 `▋`，1s 闪烁）表示生成中
- 任务进度：进度条 320ms 宽度过渡
- **禁用**：弹跳、旋转、闪烁文字、`linear` 缓动

## 七、图标

- 一律用 **Lucide React**，线宽 `strokeWidth={1.75}`，尺寸默认 16/20，与文字 `text-sm/base` 对齐。
- 不混用其它图标库。自定义图标走同一线性风格。
- 纯图标按钮必须有 `aria-label` + tooltip。

## 八、基础组件规范（ShadCN 定制）

### 8.1 Button

| 变体 | 视觉 | 用途 |
|---|---|---|
| `primary` | `bg-brand-500 text-white`，hover `brand-600` | 主操作（运行编排、保存） |
| `secondary` | `bg-bg-3 text-fg-1 border` | 次操作（取消、编辑） |
| `ghost` | 透明，hover `bg-bg-3` | 工具栏、列表项 |
| `danger` | `bg-danger text-white` | 删除、终止 |
| `outline` | `border-brand-500 text-brand-500` | 强调次操作 |

- 尺寸：`sm`（h-8 px-3 text-sm）、`md`（h-9 px-4）、`lg`（h-10 px-6）、`icon`（h-9 w-9）。
- loading 态：文字换成 `<Spinner>`（Lucide Loader2 旋转），禁用点击。

### 8.2 Input / Textarea / Select

- `bg-bg-1` 底，`border` 描边，`radius-md`，`h-9`，`text-base`。
- focus：`border-brand-500` + 2px ring。
- 错误：`border-danger` + 下方 `text-danger text-xs` 提示。
- placeholder 用 `fg-3`。

### 8.3 Card / Panel

- `bg-bg-1 border rounded-lg p-4`，无阴影（深色下靠 border 分层）。
- 卡片标题区 `pb-3 border-b`，内容区 `pt-3`。

### 8.4 Dialog / Drawer

- 背板：`bg-bg-0/70 backdrop-blur-sm`。
- 主体：`bg-bg-2 border rounded-lg shadow-3`。
- Drawer 从右滑入，宽 420（检视器）/ 600（详情）。
- Esc 关闭，点击背板关闭。

### 8.5 Toast

- 右下角，`bg-bg-2 border rounded-md shadow-2 px-4 py-3 text-sm`。
- 类型图标：success ✓（绿）/ warning !（黄）/ danger ✕（红）/ info ℹ。
- 4s 自动消失，hover 暂停。

### 8.6 Table

- 密度：`h-11` 行，hover `bg-bg-3`。
- 表头 `text-xs uppercase tracking-wide fg-2`。
- 行间无横线，靠 hover 区分；或全行细横线 `border-b`（二选一，全应用统一）。

### 8.7 Tabs

- 下划线式：选中 `border-b-2 border-brand-500 text-fg-1`，未选 `text-fg-2`。
- 不用胶囊式（占视觉空间）。

### 8.8 Empty / Loading / Error 态

- **Empty**：居中，`fg-3` 图标（Lucide Inbox/PackageOpen）+ 一行说明 + 一个引导主操作按钮。
- **Loading**：骨架屏（`bg-bg-3 animate-pulse`），不用全屏 spinner。列表用 3~5 个骨架行。
- **Error**：`border-l-2 border-danger` 卡片，标题 + 详情 + 重试按钮。

## 九、本应用特有模式

### 9.1 聊天消息流（首页主助手）

- **布局**：单列，最大宽 760px 居中，消息间距 24。
- **用户气泡**：右对齐，`bg-brand-500 text-white rounded-2xl rounded-br-sm px-4 py-2`，最大宽 85%。
- **AI 气泡**：左对齐，`bg-bg-1 border rounded-2xl rounded-bl-sm px-4 py-3`，不限宽（含 Markdown 内容）。
- **头像**：左侧 28px 圆形，AI 用品牌色 + Lucide Sparkles，用户用首字母。
- **流式光标**：生成中在末尾闪烁竖线 `▋`，`animate-pulse`，1s 周期。生成结束光标消失。
- **Markdown 渲染**：
  - 代码块：`bg-bg-2 rounded-md p-3 font-mono text-sm`，右上角复制按钮（ghost icon）。
  - 行内代码：`bg-bg-3 px-1.5 py-0.5 rounded-sm font-mono text-[0.85em]`。
  - 公式（KaTeX）：块级居中，行内贴文字基线。
  - 引用：`border-l-2 border-brand-500 pl-3 fg-2`。
  - 表格：水平滚动，紧凑。
- **工具调用卡片**：嵌在 AI 气泡内，折叠态显示 `🔧 工具名 → 已完成`，展开显示参数 + 结果（代码块）。

### 9.2 能力编排画布（核心，ReactFlow）

**画布**：`bg-bg-0`，点阵网格背景（`bg-[radial-gradient(circle,var(--color-bg-3)_1px,transparent_1px)] background-[length:20px_20px]`）。

**六类节点视觉**（节点 id == executor_id，运行态高亮用 brand-500）：

| 节点类型 | 视觉特征 | 图标 |
|---|---|---|
| **agent** | 圆角矩形 `bg-bg-1 border rounded-lg w-64`，头像+name+model 小字；运行中 `border-brand-500 shadow-[0_0_0_2px_var(--color-brand-500)]` | Bot |
| **sequential** | 竖向虚线容器，左上角"序"标签，子节点纵向排列 | ListOrdered |
| **concurrent** | 横向虚线容器，左上角"并"标签，子节点横向排列 | Boxes |
| **groupchat** | 圆角容器，左上角"群聊"标签 + 当前发言者高亮 | MessagesSquare |
| **handoff** | 节点间连线带箭头 + 条件标签，激活路径高亮 | ArrowRightLeft |
| **magentic** | Leader 居中，Worker 环绕，虚线辐射连接 | Network |

- 节点选中：`outline-2 outline-brand-500`。
- 选中节点拖动手柄：顶部 4px 拖动条 `bg-border`。
- 连线：贝塞尔曲线，默认 `stroke-border`，激活 `stroke-brand-500 strokeWidth-2`，条件边带标签胶囊。
- 运行态：节点边框 brand-500 脉冲（`animate-pulse` 但只脉冲边框），完成转 success 描边，失败转 danger。

**节点检视器**：右侧 Drawer 宽 420，选中节点即打开。分 Tab：配置 / 工具 / 运行日志。

**节点面板**：左侧可拖入，分类折叠，拖拽预览用半透明节点幽灵。

### 9.3 管理后台（角色/技能/模型/能力列表）

- 统一表格范式（§8.6）+ 顶部工具栏（搜索 + 筛选 + 新建）。
- 列表项点击进编辑抽屉（Drawer 600）。
- 表单用 React Hook Form + Zod，字段分 Section 卡片。

### 9.4 设置页

- 左侧二级导航，右侧 720 内容区。
- 分组：个人档案（称呼/角色描述/偏好语种——单用户无登录，L0 身份块从这里取，见 REWRITE_PLAN §三之三 D）、外观（主题/字号/密度，详见 §12.6）、LLM 配置（中转地址/key/默认模型，key 输入框用 `type=password` 且只走主进程保存）、快捷键、开机自启、关于。
- 每项设置一行：左标签 + 说明，右控件，`h-12 border-b`。

## 十、主题模式

- **默认纯白通透**（`:root` 无额外 class）。
- 夜色为可选对等主题：`:root.dark` 覆盖同名变量。
- 用户可在设置切换：**系统 / 纯白 / 暖白 / 夜色**（详见 §十二主题系统）。
- 切换通过 `document.documentElement.classList` 增删 `dark`/`warm`，变量覆盖即生效，无需重渲染。
- 跟随系统：监听 `nativeTheme`（主进程）+ `prefers-color-scheme`，推到渲染层。
- **画布网格、节点、连线**在夜色下需单独校准对比度（纯白为主设计，夜色下 border 提到 `border-strong`）。

## 十一、无障碍

- 文字对比度：正文对背景 ≥ 4.5:1（AA），大字 ≥ 3:1。纯白下 `fg-1`(#1F2329) on `bg-0`(#FCFCFD) ≈ 15:1 达标。
- 焦点可见：所有可交互元素 focus 必须有 2px brand-500 ring + 2px offset。不删 `:focus-visible`。
- 键盘可达：画布节点 Tab 切换，方向键移动，Enter 打开检视器，Delete 删除。
- 动效偏好：`@media (prefers-reduced-motion: reduce)` 下关闭非必要动效。
- 图标按钮必 `aria-label`。

## 十二、主题系统（可自定义）

> 主题是 One 的一等公民：默认提供几套预设，用户可改点缀色、调中性色阶、换背景图、调玻璃模糊度，所有配置存本地。设计目标是"换肤不重构"——视觉令牌全部用 CSS 变量，主题切换 = 变量覆盖，零重渲染。

### 12.1 设计目标

1. **换肤不重构**：所有颜色/玻璃/模糊度走 CSS 变量（见 §2.1），主题切换只改变量，组件代码零改动。
2. **预设 + 自定义两层**：内置预设主题（纯白通透/暖白/夜色…），用户基于预设再微调（点缀色、背景图、模糊度、密度），微调项存本地。
3. **背景图可换**：用户可上传图片作画布背景，玻璃面板 `backdrop-filter` 自动吸附背景图产生质感变化；背景图不进渲染层明文存储，经主进程处理存 `userData`。
4. **实时预览**：设置页改主题参数即时预览，确认后保存。
5. **跟随系统**：可设为跟随系统深浅（`nativeTheme` + `prefers-color-scheme`）。

### 12.2 主题数据模型

```ts
// shared/types.ts —— 主题配置（主/渲染共享，IPC 传输）
interface ThemeConfig {
  preset: 'pure-white' | 'warm' | 'dark' | 'custom';  // 预设基线
  mode: 'system' | 'light' | 'dark';                   // 明暗模式（system=跟随系统）

  // —— 颜色覆盖（null=用预设值）——
  accent?: string | null;        // 点缀色主色 hex，自动派生 300/400/600 三档
  bgOverride?: string | null;     // 画布底色 hex（用于背景图时的兜底色）
  fgOverride?: string | null;    // 主文字色 hex（用户可调对比）

  // —— 玻璃参数 ——
  glassTint?: 'neutral' | 'warm' | 'cool';  // 玻璃色温倾向
  glassBlur?: number;                        // 模糊强度 px（8~32，默认 16）
  glassOpacity?: number;                     // 玻璃不透明度 0.4~0.9（默认 0.6）

  // —— 背景图 ——
  background?: {
    type: 'none' | 'image' | 'gradient';
    imageId?: string;     // 主进程存的图片 id（不存路径/明文）
    blurPx?: number;      // 背景图自身模糊（让玻璃更通透）
    dimAmount?: number;   // 背景图压暗 0~0.6（夜色下提升对比）
    position?: 'cover' | 'contain' | 'center';
  };

  // —— 密度 ——
  density?: 'comfortable' | 'compact' | 'spacious';

  // —— 字体 ——
  fontScale?: number;     // 字号缩放 0.9~1.2
  fontMono?: string;     // 等宽字体名
}

// 默认主题 = 纯白通透 + 薄荷绿
const DEFAULT_THEME: ThemeConfig = {
  preset: 'pure-white',
  mode: 'system',
  accent: '#4ECDC4',
  glassTint: 'cool',
  glassBlur: 16,
  glassOpacity: 0.6,
  background: { type: 'none' },
  density: 'comfortable',
  fontScale: 1.0,
};
```

### 12.3 内置预设

| 预设 | 画布底 | 中性色温 | 玻璃色温 | 点缀色默认 | 适用 |
|---|---|---|---|---|---|
| `pure-white` | `#FCFCFD` 冷白 | 冷 | 冷 | 薄荷绿 `#4ECDC4` | 默认，干净通透 |
| `warm` | `#FBF8F1` 暖白 | 暖 | 暖 | 暖琥珀 `#D98E3A` | 喜欢暖调的用户 |
| `dark` | `#0E1116` 夜色 | 冷 | 冷 | 薄荷绿 `#4ECDC4` | 夜间/护眼 |
| `custom` | 用户自定 | — | — | 用户自定 | 微调后保存为自定义 |

### 12.4 实现架构

```
┌──────────────────────────────────────────────────────┐
│ 渲染进程                                               │
│  ┌─────────────┐   ┌──────────────────────────────┐  │
│  │ 设置页 UI    │──▶│ ThemeStore (Zustand)          │  │
│  │ (实时预览)  │   │ - 持有当前 ThemeConfig        │  │
│  └─────────────┘   │ - applyTheme() 生成 CSS 变量   │  │
│                     │   写入 :root.style            │  │
│                     └──────────────┬───────────────┘  │
│                                    │ IPC              │
│  ┌─────────────────────────────────▼──────────────┐  │
│  │ applyThemeToDOM(cfg)                          │  │
│  │  - 把 hex → 派生 300/400/600 三档             │  │
│  │  - 设 --color-brand-* / --glass-* / --bg-0 等 │  │
│  │  - 设 documentElement.classList (dark/warm)    │  │
│  │  - 背景图：设 body background-image            │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────┬───────────────────────────────┘
                       │ window.one.theme.*
┌──────────────────────▼───────────────────────────────┐
│ 主进程                                                │
│  ┌──────────────────────────────────────────────┐   │
│  │ theme/                                        │   │
│  │  - load():   读 userData/theme.json          │   │
│  │  - save(cfg):写 userData/theme.json          │   │
│  │  - saveBg(file):图片复制到 userData/bg/      │   │
│  │      返回 imageId（不暴露真实路径）           │   │
│  │  - loadBg(imageId):返回 dataURL 给渲染层     │   │
│  │  - watchSystem():监听 nativeTheme → 推 mode  │   │
│  └──────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

### 12.5 关键实现要点

**1. CSS 变量是唯一通道**
所有视觉元素只认 CSS 变量（`--color-*` / `--glass-*`），组件代码里不出现 hex/rgb。换肤 = 改 `:root.style` 上的变量值。这样预设切换、用户微调、背景图生效都走同一条路。

**2. 点缀色派生**
用户只给主色 hex（`accent`），前端用 OKLCH 色空间派生：
- `brand-300`：提亮 12%（hover/渐变）
- `brand-400`：提亮 6%（次操作）
- `brand-500`：原色（主操作/激活）
- `brand-600`：压暗 6%（按下/聚焦）

```ts
function deriveAccentShades(accent: string) {
  const [L, C, H] = hexToOklch(accent);
  return {
    '--color-brand-300': oklchToHex(L + 0.12, C, H),
    '--color-brand-400': oklchToHex(L + 0.06, C, H),
    '--color-brand-500': accent,
    '--color-brand-600': oklchToHex(L - 0.06, C, H),
  };
}
```

**3. 背景图（重点）**
- 用户在设置页上传图片 → `window.one.theme.setBackground(file)` → 主进程 `saveBg` 复制到 `userData/bg/<imageId>.<ext>`，只返回 `imageId`。
- 渲染层用 `loadBg(imageId)` 拿 dataURL，设到 `body` 的 `::before` 伪元素（`position:fixed; inset:0; z-index:-1; background-image:url(...); background-size:cover;`）。
- 玻璃面板 `backdrop-filter: blur()` 自动吸附背景图，产生"窗外有景"的通透质感。
- 背景图可调：自身模糊 `blurPx`（图太花时压住）、压暗 `dimAmount`（保证文字对比）。
- **密钥/敏感数据不混入**：背景图经主进程处理，渲染层只拿到 dataURL，不碰文件系统路径。

**4. 明暗跟随系统**
- `mode: 'system'` 时，主进程监听 `nativeTheme.shouldUseDarkColors`，变化时 IPC 推给渲染层。
- 渲染层收到后增删 `documentElement.classList` 的 `dark`，变量覆盖即生效。
- 用户手动选了纯白/暖白/夜色，则覆盖系统判断（手动优先）。

**5. 实时预览**
设置页改任何参数 → 立即调 `ThemeStore.applyTheme()` 写 CSS 变量 → 页面即时变。确认才 `save` 到主进程；取消则回滚到已保存值。Zustand 存"未保存草稿"和"已保存"两份。

**6. 密度与字号**
- `density` 调间距 token（`--spacing-*` 全局乘系数）。
- `fontScale` 调 `html { font-size }`（rem 基准），所有 rem 字号跟随。
- 二者都是 CSS 变量级调整，不碰组件。

**6.1 玻璃与密度参数 → CSS 变量映射**（applyTheme 实现依据）

| ThemeConfig 字段 | 取值 | 映射到 CSS 变量 |
|---|---|---|
| `glassTint: 'cool'` | 冷调 | `--glass-bg` 用偏冷白 `rgba(255,255,255,0.6)`；`--glass-border-bottom` 用冷灰 `rgba(120,130,145,0.12)` |
| `glassTint: 'warm'` | 暖调 | `--glass-bg` 用偏暖白 `rgba(255,252,248,0.6)`；`--glass-border-bottom` 用暖灰 `rgba(140,120,90,0.12)` |
| `glassTint: 'neutral'` | 中性 | `--glass-bg` 用纯白 `rgba(255,255,255,0.6)`；`--glass-border-bottom` 用中性灰 `rgba(128,128,128,0.12)` |
| `glassOpacity: 0.4~0.9` | 不透明度 | `--glass-bg` 的 alpha 通道 = opacity（如 0.4 → `rgba(255,255,255,0.4)`） |
| `glassBlur: 8~32` | 模糊 px | `--glass-blur` = 值（默认 16）；`--glass-blur-strong` = 值+8（弹层用） |
| `density: 'compact'` | 紧凑 | `--spacing-*` 全局 × 0.85 |
| `density: 'comfortable'` | 舒适（默认） | `--spacing-*` 全局 × 1.0 |
| `density: 'spacious'` | 舒展 | `--spacing-*` 全局 × 1.15 |
| `fontScale: 0.9~1.2` | 字号缩放 | `html { font-size: calc(16px * <fontScale>) }` |

> 玻璃色温的实现：applyTheme 根据 glassTint 选一组"底色基线 + 描边基线"RGBA，再叠加 glassOpacity 到 alpha 通道，统一写入 `--glass-*` 变量。组件代码只读 `--glass-bg`/`--glass-border-*`，不感知色温/不透明度如何来的。

**7. 主题持久化与加载时机**
- 主进程启动 → 读 `userData/theme.json` → IPC 推给渲染层 → 渲染层在 `main.tsx` 最早期 `applyTheme`，避免首屏闪白（FOUC）。
- 为进一步防闪白，preload 可在 `document` 创建早期注入一段内联 `<style>`，设默认主题变量。

### 12.6 设置页"外观"分区设计

外观设置分区（§9.4 设置页）展开：

- **主题预设**：纯白通透 / 暖白 / 夜色 / 自定义（卡片网格，每张是主题缩略图，点击切换并实时预览）
- **明暗模式**：跟随系统 / 始终纯白 / 始终暖白 / 始终夜色（分段控件）
- **点缀色**：6 个预设色块（薄荷绿/天空蓝/青柠/蜜桃粉/暖琥珀/紫罗兰）+ 自定义色板
- **背景**：无 / 上传图片（上传后显示缩略图 + 模糊滑块 + 压暗滑块）/ 渐变（两色 + 角度）
- **玻璃**：色温（中性/暖/冷）+ 模糊强度滑块 + 不透明度滑块
- **密度**：紧凑/舒适/舒展（分段控件）
- **字号**：滑块 0.9~1.2，实时预览
- 每个控件改动即时预览；底部"重置默认"和"保存"按钮。

### 12.6.1 背景图功能（设置页"背景"子项完整规格）

> 背景图是主题的亮点功能：玻璃面板 `backdrop-filter` 吸附背景图，产生"窗外有景"的通透质感。**支持直接引用本地路径**（用户给个 `/Users/shijianzhong/aa.jpg` 即可），可选"导入副本"。

**功能定义**
用户可在设置页"外观 > 背景"配置画布背景：
- 三种背景类型：无（默认，纯色底）/ 图片 / 渐变。
- 图片背景支持两种来源（用户二选一）：
  - **本地路径**（默认）：用户直接给一个本地图片路径（如 `/Users/shijianzhong/aa.jpg`），应用直接引用，**不复制文件**。最自然、不占双份空间，用户改原图立即生效。
  - **导入副本**（可选）：把图片复制压缩进 `userData/bg/`，原图删了也不影响，适合想"一次导入、长期使用"的用户。
- 渐变背景：用户选两色 + 角度，生成 CSS 渐变作背景（轻量，无文件）。

**交互流程（图片）**
1. 设置页"背景"区：类型切换（无/图片/渐变）。
2. 选"图片"→ 显示一个选图区，两种输入方式并存：
   - **点击选择**：触发主进程原生文件选择框 `dialog.showOpenDialog`（支持 jpg/png/webp/avif），选完拿到绝对路径。
   - **粘贴/输入路径**：一个文本框，用户可直接粘贴或手输本地绝对路径（如 `/Users/shijianzhong/aa.jpg`），失焦校验路径存在 + 是图片格式。
3. 选定后显示缩略图 + 四个控件：
   - **来源模式** 单选：`引用本地路径`（默认）/ `导入副本到应用`（点"导入"按钮触发复制压缩）。
   - **图片模糊** `blurPx`（0~20px）：背景图自身模糊，图太花时压住，让前景玻璃更通透。
   - **压暗** `dimAmount`（0~0.6）：叠一层黑色遮罩，提文字对比；夜色主题下尤其重要。
   - **铺满方式** `position`（cover/contain/center）：cover 裁切铺满、contain 完整留白、center 居中。
4. 所有调整实时预览（背景图立即生效）。
5. "保存"才落盘；"重置"回已存值；"移除"清空回"无"。
6. **本地路径失效提示**：若来源是本地路径且启动时校验路径已不存在（用户删/移了原图），设置页显示"背景图文件已失效，请重新选择"，背景自动回退纯色，不崩。

**渐变背景**
选"渐变"→ 两个颜色拾取器 + 角度滑块（0~360°）→ 生成 `linear-gradient(<angle>deg, c1, c2)`。无文件、轻量，适合想要一点色彩氛围又不想上图的用户。

**数据模型**（§12.2 `ThemeConfig.background` 展开）：
```ts
background: {
  type: 'none' | 'image' | 'gradient';
  // 图片来源（二选一）：
  source?: 'path' | 'imported';     // path=引用本地路径（默认），imported=已导入副本
  filePath?: string;                 // source='path' 时，本地绝对路径，如 /Users/x/aa.jpg
  imageId?: string;                  // source='imported' 时，userData/bg/ 下的副本 id
  blurPx?: number;                   // 背景图自身模糊 0~20，默认 0
  dimAmount?: number;                 // 压暗 0~0.6，默认 0（纯白）/ 0.3（夜色）
  position?: 'cover' | 'contain' | 'center';  // 默认 cover
  // 仅渐变：
  gradient?: { from: string; to: string; angle: number };
}
```

**IPC 接口**
> ⚠️ File 对象无法通过 contextBridge 序列化。渲染层只传字符串路径，主进程处理文件读取/复制。

```ts
window.one.theme.pickBackground(): Promise<{ filePath: string } | null>   // 主进程弹 dialog 选图，返回绝对路径
window.one.theme.setBackgroundPath(filePath: string): Promise<{ ok: boolean; error?: string }>  // 校验路径+是图片格式
window.one.theme.importBackground(filePath: string): Promise<{ imageId: string }>  // 复制压缩到 userData/bg/，返回 imageId
window.one.theme.loadBackground(bg: BackgroundConfig): Promise<{ dataUrl: string | null; stale?: boolean }>  // 按配置取 dataURL；path 失效返回 null + stale=true
window.one.theme.removeBackground(imageId?: string): Promise<void>  // imported 模式删副本；path 模式只清配置（不删用户原图）
// 最终背景配置随 ThemeConfig 一起 save/load（见 §12.4）
```

**主进程实现**（`main/theme/background.ts`）
- `loadBackground(bg)`：按 `bg.source` 分流——
  - `source='path'`：校验 `bg.filePath` 存在 → 读文件 → 压缩（长边 ≤2560px、≤2MB、转 webp）→ 返回 dataURL。路径不存在返回 `{ dataUrl: null, stale: true }`。
  - `source='imported'`：读 `userData/bg/<imageId>.<ext>` → 返回 dataURL。
- `importBackground(filePath)`：读用户路径文件 → 压缩（长边 ≤2560px、≤2MB、转 webp）→ 存 `userData/bg/<imageId>.webp` → 返回 imageId（不暴露用户原始路径给渲染层之外的存储）。
- `pickBackground()`：`dialog.showOpenDialog` 拿绝对路径，校验格式，返回路径字符串。
- `removeBackground(imageId?)`：imported 模式删 `userData/bg/<imageId>.*`；path 模式无副本可删，只清配置。换图时自动删旧 imported 副本，不留垃圾。

**渲染层应用**（`applyThemeToDOM`）
```ts
// 背景图：设到 body::before，铺满、不滚动、不接收事件
const bg = theme.background;
if (bg.type === 'image') {
  const { dataUrl, stale } = await window.one.theme.loadBackground(bg);
  if (stale) {
    // 本地路径失效：回退纯色，提示用户
    document.documentElement.classList.remove('has-bg-image');
    toast.warning(t('theme.background.stale'));
  } else if (dataUrl) {
    document.documentElement.style.setProperty('--app-bg-image', `url(${dataUrl})`);
    document.documentElement.style.setProperty('--app-bg-blur', `${bg.blurPx ?? 0}px`);
    document.documentElement.style.setProperty('--app-bg-dim', `${bg.dimAmount ?? 0}`);
    document.documentElement.classList.add('has-bg-image');
  }
}
/* CSS:
body::before {
  content: ''; position: fixed; inset: 0; z-index: -2;
  background-image: var(--app-bg-image, none);
  background-size: cover; background-position: center;
  filter: blur(var(--app-bg-blur, 0)) brightness(calc(1 - var(--app-bg-dim, 0)));
}
.has-bg-image body { background: transparent; }  // 让背景图透出
*/
```
渐变同理，把 `--app-bg-image` 设成 `linear-gradient(...)`。

**边界与约束**
- **正文可读性兜底（铁律）**：有背景图时，正文区（聊天气泡内容、代码块、表格行）强制用 `--color-bg-1`（实色厚白）托底，**不让正文直接压在背景图上**。"玻璃是框，实色是内容"依然成立——玻璃面板可以透出背景图，正文卡片必须实色。
- **对比度警告**：背景图 + 玻璃变化后，若主文字对玻璃底对比不足 4.5:1，设置页显示警告条提示调高压暗。
- **本地路径安全**：渲染层只传路径字符串给主进程，主进程读文件转 dataURL，**渲染层不直接访问文件系统**（`file://` 受安全策略限制）；用户路径不外泄、不上传。
- **路径失效兜底**：本地路径模式启动时校验路径存在性，失效自动回退纯色 + 提示，不崩不白屏。
- **性能**：dataURL 缓存在 ThemeStore（同一会话不重复读）；本地路径大图由主进程压缩后再传渲染层，避免渲染层卡顿；切换主题时不重复解码。**首次加载有 IPC 传输延迟**（2MB 图 base64 后约 2.7MB），建议导入副本时压到 ≤ 1MB 控制 payload。
- **格式/大小**：支持 jpg/png/webp/avif；本地路径无大小硬限制（主进程读取时压缩），导入副本压缩后 ≤ 2MB。
- **背景图不进主题预设**：预设只定义颜色/玻璃/密度，背景图是用户自定义数据，不内置在任何预设里。
- **用户原图不删**：path 模式绝不删用户原始文件；imported 模式只在"移除"时删 userData 副本，不动用户原图。

### 12.7 边界与约束

- **不改组件代码换肤**：任何"为某主题加 if/else"的做法都是错的，应转成 CSS 变量。
- **背景图不伤可读**：用户设背景图时，玻璃下面的正文区强制用 `--color-bg-1`（实色厚白）托底，不让正文直接压在背景图上（"玻璃是框，实色是内容"铁律依然成立）。
- **对比度兜底**：点缀色/背景图变化后，主文字色若对比不足 4.5:1，自动在 `fgOverride` 提示警告。
- **预设不可删除**：`pure-white`/`warm`/`dark` 三套预设只读，用户改了参数后存为 `custom`，不污染预设。
- **性能**：背景图大图先经主进程压缩到 ≤ 2560px / ≤ 2MB 再存，避免渲染层卡顿。

### 12.8 落地任务清单

- [ ] `shared/types.ts` 定义 `ThemeConfig` + `DEFAULT_THEME`
- [ ] `renderer/src/styles/theme.css` 全变量化（§2.1）
- [ ] `renderer/src/store/themeStore.ts`（Zustand）：applyTheme / 草稿与已存两份
- [ ] `renderer/src/lib/color.ts`：hex↔oklch、点缀色派生
- [ ] `main/theme/index.ts`：load/save/saveBg/loadBg/watchSystem
- [ ] preload 暴露 `window.one.theme.{get,set,setBackground,reset}`
- [ ] 设置页"外观"分区（§12.6 全部控件 + 实时预览）
- [ ] 防首屏闪白（preload 内联默认主题 style）
- [ ] 背景图压缩与实色托底
- [ ] 对比度兜底警告

## 十三、交付清单（每个页面/组件 PR 须满足）

- [ ] 颜色全走 CSS 变量，无硬编码 hex/rgb（含玻璃元素走 `--glass-*`、遮罩走 `--overlay-bg`）
- [ ] 间距是 4 的倍数
- [ ] 纯白/暖白/夜色三套预设都校准过对比度
- [ ] 焦点态可见
- [ ] empty / loading / error 三态齐全
- [ ] 纯图标按钮有 `aria-label` + tooltip
- [ ] 动效在 reduced-motion 下关闭
- [ ] 流式生成有光标、无抖动
- [ ] 正文/代码/表格用实色 `--color-bg-1`，不用 `--glass-bg`（玻璃是框，实色是内容）
- [ ] 新组件在纯白/暖白/夜色三套预设下都校准过对比度，不依赖单一主题
