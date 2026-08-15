---
name: 配图落盘纪律
description: 阶段5配图+落盘——改poster HTML模板+Chrome headless截图，落Obsidian vault
tags: [content-pipeline, image, publish]
---

# 配图落盘纪律（A5 content-imager）

阶段5配图+落盘按本纪律跑。配图走 HTML + Chrome headless（坚决不用 PIL，中文+emoji+字体跨平台全是坑）。

## 配图工具

| 工具 | 用途 |
|------|------|
| `poster_render` | HTML 模板 + 变量填充 + Chrome headless 截图 → PNG |
| `file_write` | 落盘正文/HTML 源到 Obsidian vault |

## 配图流程

### 1. 填模板文案
`poster_render` 工具读模板（builtin overlay：用户改过的副本优先，否则出厂内置 wechat-poster.html），填入变量（vars 键值替换 {{key}} 占位）：
- 封面：title-line1/2、sub、footer，高度 630
- 引子图：同理，高度 675

### 2. 截图
`poster_render`（outPath 指向 vault 当日目录，height=封面630/引子图675）→ Chrome 4件套（headless=new / hide-scrollbars / force-device-scale-factor=1 / window-size=1200,H）截图。

### 3. 校验
产出的 PNG 验尺寸：封面 1200×630，引子图 1200×675。深度文必出 2 张（封面+引子图），清单型可加长图 poster（1200×2300，>5条按 ceil(N/5) 拆系列图）。

## 落盘规范

正文+配图存 Obsidian vault `$VAULT/DailyNotes/{YYYY-MM-DD}/`（VAULT 默认 ~/sh，可 OBSIDIAN_VAULT 覆盖），按日期分桶。

### 目录结构
```
$VAULT/DailyNotes/2026-08-14/
├── 2026-08-14-公众号-{slug}.md     ← 正文
├── {slug}-cover.png / .html        ← 封面 1200×630
└── {slug}-intro.png / .html        ← 引子图 1200×675
```

### 文件命名
- 正文：`{YYYY-MM-DD}-公众号-{slug}.md`（slug 英文短横线）
- 配图：`{slug}-cover.png` / `{slug}-intro.png`，与正文同目录

### Frontmatter
正文 frontmatter 含：title / date / tags / type:wechat-tech-article / direction / topic_source(GitHub+reddit 来源) / cover_image / intro_image / related_notes(内链) / ai_cavity_score / status:draft

### 内链（写前必做）
产出前用 `web_search` 或 vault 搜索扫 ≥3 篇相关文，写进 frontmatter `related_notes`，用 `[[标题]]` 语法。内链提升 vault 网状结构和读者停留。

## 配图关联
通过 frontmatter `cover_image` / `intro_image` 软关联（文件名引用）。文章 md 和图片 png/html 物理并列同目录。

## 发布时段
晚 8-10 点最佳（阅读高峰）。输出建议时段，用户手动发（**不自动推送微信**，发布权在用户）。

## Discipline

深度文必出 2 张图（封面+引子图），尺寸必须 1200×630 / 1200×675。坚决不用 PIL（中文+emoji+字体坑），走 HTML 所见即所得。落盘必带完整 frontmatter（含 cover_image/intro_image 软关联 + related_notes 内链 ≥3 篇 + ai_cavity_score）。发布权在用户，不自动推送。
