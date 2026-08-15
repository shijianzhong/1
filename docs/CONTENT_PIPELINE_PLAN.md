# One — 内容生产能力拆解编排方案

> 日期：2026-08-14
>
> 目标：把 `~/.claude/skills/wechat-tech-content` 这个单体 skill，拆解成 One 运行时的 **Agent × Tool × 知识资产 × Capability 编排图**，沉淀为 One 产品内置的「公众号技术深度文生产」可视化编排能力。
>
> **本文档是方案，经用户确认后再落地。不在此阶段写任何实现代码。**
>
> 调研依据：三份并行 Explore 调研（存储层 / 编排引擎 / 工具注册），全部代码事实截至 2026-08-14。

---

## 一、设计决策（用户已定）

| 维度 | 决策 | 理由 |
|------|------|------|
| 沉淀形态 | **One 运行时的 Agent 能力**（非 Claude Code skill） | 变成 One 产品内置的可视化编排工作流，在画布上可编排可复用 |
| 拆分粒度 | **细粒度：每阶段一个独立 agent** | 内容生产 6 阶段，每阶段一个 agent，各自可单独调用、可组合到其他工作流 |
| 资产归属 | **落进 One 项目，用数据库存储** | 照 One 现有存储范式，知识资产分类落 SQLite / JSON / 目录化 |

---

## 二、能力全景：从单体 skill 到 One 运行时

原 skill 是 1 个 SKILL.md（99 行编排表）驱动 6 阶段。拆解后映射成 4 类 One 运行时实体：

```
原 skill 单体                          One 运行时（拆解后）
─────────────                          ──────────────────────
SKILL.md 编排逻辑         ──→          Capability（编排图，6节点 sequential）
6 阶段执行逻辑             ──→          6 个 Agent（每阶段一个，source='builtin'）
风格画像/选题库/样文       ──→          知识资产（4类，落库/落目录）
调研脚本/配图脚本/AI腔     ──→          builtin Tool（5个新工具）
阶段间传递的规范           ──→          Skill（ContextProvider 注入 instructions）
```

### 2.1 Agent 拆解（6 个，source='builtin'）

每个 agent = `Agent` 实体（`shared/types.ts:441-465`），`source: 'builtin'`，固化进代码随包分发。

| # | Agent name | 对应原 skill 阶段 | 职责 | 绑定 Skill | 绑定 Tool（allowedToolNames） |
|---|-----------|----------------|------|-----------|---------------------------|
| A1 | `content-researcher` | 阶段1 选题调研 | 多平台并行调研（**opencli 中文社区主力** + GitHub/Reddit/Exa/全网），出选题价值评估表+三维过筛+判断结论 | `topic-research-discipline` | `opencli_run`, `web_search`, `exa_search`, `reddit_search`, `gh_search`, `topic_add`, `ask_user` |
| A2 | `content-benchmark` | 阶段2 对标拆解 | 拆解有热度同类号，提炼所长，样文入库 | `benchmark-discipline` | `web_read`, `sample_article_save` |
| A3 | `content-stylist` | 阶段3 风格固化 | 综合拆解所长+样文，回填风格画像 | `style-freeze-discipline` | `style_profile_update`, `sample_article_read` |
| A4 | `content-writer` | 阶段4 产出初稿 | 套风格模板+6段式写稿，标30%人工改写点 | `writing-style`（核心风格画像） | `topic_get`, `sample_article_read`, `style_profile_read`, `web_read`（核验事实） |
| A5 | `content-imager` | 阶段5 配图 | 改 poster HTML 模板+Chrome headless 截图，落 Obsidian | `image-discipline` | `poster_render`, `file_write` |
| A6 | `content-reviewer` | 阶段6 review 自检+改稿内闭环 | 对抗式核验事实+5维爆款打分+对标对比；判返工则自闭环改稿再审，收敛或达迭代上限（≤3 轮）终稿交付 | `review-discipline`（含审后改稿纪律） | `gh_repo_view`, `exa_search`, `web_read`, `review_archive_save`, `ai_cavity_audit`, `file_write` |

> **A1 调研可并行**：A1 节点内部用 concurrent 容器嵌套（各平台调研 sub-agent + 聚合 sub-agent），见 §四图结构。
>
> **A6 内闭环改稿（路线1，已定）**：A6 拿到 A4 初稿后在自身 tool-use 循环内 review → 判返工 → 调 `file_write` 改稿 → 再审，收敛或达迭代上限（≤3 轮）终稿交付。图仍是 A1→A2→A3→A4→A5→A6 纯线性，**不加回路边、不碰引擎环检测**。审改同由 A6 担任（取舍见 §七-6），等 context_mode 落地后再评估升级为"条件边回流 A6→A4"的审改分离。

### 2.2 Tool 拆解（6 个新 builtin tool）

照 `registry.ts` 范式注册。工具不经 IPC，agent 自动从 registry 取（`listToolsForAgents()`）。随包 builtin（见 §2.5），所有用户即用。

| Tool name | 原脚本/能力 | 范式参考 | approvalMode | 访问资源 |
|-----------|-----------|---------|--------------|---------|
| `exa_search` | Exa 语义搜索 | `web.ts` 范式A（HTTP fetch） | auto | Exa API（key 从 process.env） |
| `reddit_search` | Reddit 帖子检索 | `web.ts` 范式A 或扩展 opencli | auto | Reddit API / opencli |
| `gh_search` | GitHub trending/仓库核验 | `shell.ts` spawn `gh` | auto | gh CLI（spawn） |
| `poster_render` | `poster-screenshot.sh` Chrome 截图 | `skillScript.ts` 范式B（spawn） | auto | Chrome headless（spawn） |
| `review_archive_save` | review 档案落库 | 新建（SQLite 写） | auto | reviews 表 |
| `ai_cavity_audit` | AI腔逐句规则预筛 | 新建（纯规则，零 spawn） | auto | 无外部资源 |

> **其余已有工具复用**：`web_read`/`web_search`（web.ts 已有）、`file_write`（file.ts 已有，路径围栏 `~/sh/DailyNotes`）、`ask_user`（HITL，阶段1确认选题用）。
>
> **AI腔检测两层架构（标准化，见 §九-3）**：① `ai_cavity_audit` builtin tool 做规则预筛——输入文本→逐句扫，输出透明命中清单（自造说法候选 + `反映出/体现出/表明了` 连接词位置 + 前后句关系待核），零 LLM 成本、可解释；② A6 reviewer agent 拿预筛清单 + review-discipline §2.5 判据逐条定夺改写，LLM 判语义关系。规则只做定位不判断，避免"去AI味"靠 LLM 自觉的不透明。判据吸收自 Roland《我找到了AI写作问题的根源》。

### 2.3 知识资产拆解（4 类，落库/落目录）

照存储 agent 给的范式建议，按资产特性分配存储路径：

| 资产 | 原 skill 文件 | One 存储范式 | 落点 | 检索 |
|------|-------------|------------|------|------|
| **风格画像** StyleProfile | `assets/style-profile.md` | JsonCollection | `config/style-profiles/{id}.json` | 全量读（低频） |
| **选题库** TopicLibrary | `assets/topic-library.md` | SQLite 表 v7 `topics` | `one.db` | 按状态/时间/标签查 + 可选 FTS |
| **样文** SampleArticle | `assets/sample-articles/*.md` | 目录化 | `config/sample-articles/<id>/ARTICLE.md + references/` | 仿 skill 目录化 |
| **Review 档案** ReviewArchive | frontmatter `review_*` 字段 | SQLite 表 v8 `reviews` | `one.db` | 按资产/评分/时间查 |

> **反例锚点**（`self-baseline-note.md`）：作为 L3 记忆事实存入（`memory_retain`），不单独建表——它是单条诊断结论，用 key-value 足矣。agent 产出时 `memory_recall("本号反例")` 拉取。

### 2.4 Skill 拆解（ContextProvider，注入 instructions）

把原 skill 各阶段的"执行规范"拆成独立 Skill（目录化 `config/skills/<id>/SKILL.md`），按 agent 的 `skillIds` 绑定，`beforeRun` 注入 instructions：

| Skill | 内容来源 | 绑定 agent |
|-------|---------|-----------|
| `writing-style` | `style-profile.md` + `style-template.md` | A4 writer（核心） |
| `topic-research-discipline` | `research-playbook.md`（三维过筛+跑偏校验+切口选择） | A1 |
| `benchmark-discipline` | `teardown-guide.md` | A2 |
| `style-freeze-discipline` | style-template.md 固化段 | A3 |
| `image-discipline` | `publish-checklist.md` 配图段 | A5 |
| `review-discipline` | `review-checklist.md`（含 §2.5 AI腔逐句诊断：自造说法/英译式话语连接两类根源+连接词删读审查+改写对照表）+ 内闭环改稿纪律（先审后改、每轮列具体改点、≤3 轮上限、收敛即止） | A6 |

> 这些 Skill 的 `content` 就是原 references md 的内容（限长 24000 字，超的拆段）。`discipline` 段放该阶段的输出纪律。

---

## 2.5、内置资产分发范式（标准化，非 MVP）

> 用户决策：标准化产品，内置能力随安装包出厂、开箱即用、用户可改、改完可分享给其他用户接着改。放弃一切 MVP 取舍。
>
> 调研实证（2026-08-14 三路并行 + Explore agent 31 次工具调用摸穿链路）：
> - One 现有 **唯一** "首启预置"先例是 `seedDefaultModels()`（`models.ts:243`），只 seed Anthropic provider，agent/skill/capability 全空。
> - `source: 'builtin'` 字段 schema 已就绪（`config.ts:67`），但**首启 seed 链路从未用过它**——只在 registry 导入/导出链路透传，且 importer.ts:179-193 导入时**根本不传 source**，落库 fallback 成 `'custom'`。靠 source 字段区分 builtin/custom **已证实不可靠**。
> - `electron-builder.yml:11-24` extraResources 只放了 OpenCLI 和托盘图标，**没有任何 builtin 数据资产**。
> - `paths.ts:14-79` 所有 get*Dir() 全指向 userData（可写），**没有 builtin 只读边界**。
> - 可复用范式：OpenCLI（`opencli.ts:38-60`，`extraResources + process.resourcesPath + app.isPackaged 分流`）+ registry `isLocallyModified`（`importer.ts:54-68`，`updatedAt > importedAt`，判"官方基线 vs 用户改动"）。

**范式（路径B 修正版：固定 id + 首启复制 + isLocallyModified 升级）：**

```
随包打包（electron-builder.yml extraResources）：
  build/builtin/
    agents/*.json                 ← 6 个 builtin agent 定义
    capabilities/builtin_content_pipeline.json   ← 文件名==id（JsonCollection.get 按 {id}.json 读）
    skills/<id>/SKILL.md + scripts/ + references/   ← 6 个 skill 标准包
    sample-articles/<id>/ARTICLE.md + references/    ← 样文
    templates/wechat-poster.html                    ← 配图模板

首启落地（seedBuiltinAssets，仿 seedDefaultModels，index.ts:136 后调用）：
  读 build/builtin → 复制进 userData 可写层（config/agents|capabilities|skills|...）
  → 用户可改（改的是自己那份副本，出厂原版不动）

身份稳定（固定 id，非 generateId 随机）：
  builtin 资产用固定 id（如 builtin_content_writer）。
  用户改过也保留原 id → 导出分享给别人，别人导入后还是同一能力的演进版，可继续叠改。
  不靠易丢的 source 字段区分身份（已实证 registry 链路会丢 source）。

升级判定（实用主义实现，非 registry.isLocallyModified）：
  单文件资产（agent/capability/模板）：目标文件已存在 → 跳过覆盖（保用户改动）。
  目录型资产（skill/样文）：逐子项回填——目标子目录已存在 → 跳过该子项（保用户对该资产
    的改动）；不存在 → 复制。老用户升级时能收到新加的 builtin 子项，而非"目标根目录已
    存在就整包跳过"。
  （原设计的 isLocallyModified 覆盖判定因 builtin 不带 registry provenance/importedAt 锚点
    未采用；"提示有新版本"留作后续增强。）

引擎零侵入：builtin 复制进 userData 后，对编排引擎/runner/builder/IPC/preload 来说
  和 custom 长得一模一样，零特殊路径。引擎不区分也不在乎 builtin/custom。
```

**这套范式一次性补上"出厂基线 → 用户可改 → 可分享演进"的资产生命周期**，agent/skill/capability/样文/模板五类资产统一受益。content-pipeline 是第一个受益者；补完后任何内置能力（不限于内容生产）都能复用这套机制出厂。

**代码改动范围（不在内容能力本身，是资产分发基础设施）：**

| 改动 | 文件 | 量 | 动引擎 |
|------|------|----|--------|
| 加 builtin 出厂层路径 | `paths.ts` 新增 `getBuiltinResourcesDir()`（复用 opencli 范式） | ~3 行 | 否 |
| 打包 builtin 资产 | `electron-builder.yml` extraResources 加 `build/builtin → builtin` | 2 行 yaml | 否 |
| 放出厂资产源文件 | `build/builtin/{agents,capabilities,skills,sample-articles,templates}/` | 静态文件，非代码 | 否 |
| 首启复制 | 新增 `seedBuiltinAssets()`（仿 `seedDefaultModels`），`index.ts:136` 后调用 | ~40 行 | 否 |
| 固定 id | builtin 资产用固定 id（`builtin_*`） | 约定级 | 否 |
| 升级判定 | 复用 registry `isLocallyModified` 范式 | 复用现有 | 否 |

> 引擎层（编排/runner/builder/模式）、IPC handler 结构、preload 白名单——**零改动**。builtin 资产复制进 userData 后即用户可改的活资产，改完走现有 Registry 导出/导入分享给他人。

---

## 三、编排图：Capability 持久化

整个 6 阶段工作流存成一个 `Capability`（`{ id, name, graph: WorkflowGraph, allowedToolNames }`），走 JSON 持久化（`config/capabilities/{id}.json`，同现有 capabilities 范式）。用户可在画布上可视化编排、改、复用。

### 3.1 图拓扑

```
sequential 容器 "content-pipeline"
  ├─ A1 content-researcher（concurrent 嵌套：3平台并行 + 聚合）
  │    ├─ research-github   (gh_search)
  │    ├─ research-reddit   (reddit_search)
  │    ├─ research-exa      (exa_search)
  │    └─ research-agg      (聚合三维过筛结论)
  ├─ A2 content-benchmark   (web_read + sample_article_save)
  ├─ A3 content-stylist     (style_profile_update)
  ├─ A4 content-writer      (topic_get + style_profile_read → 产出初稿)
  ├─ A5 content-imager      (poster_render + file_write → 配图落盘)
  └─ A6 content-reviewer    (review→判返工→file_write 改稿→再审内闭环；收敛后 review_archive_save 落 review 档案 + file_write 落盘终稿 .md)
```

### 3.2 上下文流转（照编排引擎 agent 确认的机制）

- **顺序接力**：sequential 模式，`full_conversation` 转发（runner.ts L404-406）——下游 AgentExecutor extend 完整 cache，看得到原始任务+所有上游产出
- **防复述**：`wake_on_upstream`（agent.ts L168-177）——末条 assistant 且 author≠self 时追加 user 唤醒指令
- **防 2013**：下游无 tools → `stripToolBlocksFilter`；有 tools → `repairToolPairs`
- **A1 并行 fan-in**：concurrent 容器 dispatcher fan-out，所有平台调研完成 fan-in 栅栏拼合投给 research-agg
- **终稿落盘**：A4 产出正文文本经接力传给 A5（配图）和 A6（review）；**正文不在 A4 落盘**，统一由 A6 内闭环收敛后调 `file_write` 落盘终稿 .md，A5 配图同目录落 png/html——避免改稿与落盘分裂

### 3.3 HITL 挂起点（2 处人机交互）

| 挂起位置 | 机制 | 用途 |
|---------|------|------|
| A1 出完选题后 | `ask_user` 工具 → `request_info` 事件 → 前端提问卡 → `waitForUserInput` 挂起 | 等用户确认选题方向/切口 |
| A6 内闭环收敛后 | `ask_user` | 终稿交付确认——A6 自闭环改稿收敛或达上限（≤3 轮）后，把终稿 + review 档案交用户做最后润色/发布确认 |

> HITL 走 `ask_user` 工具桥（userInput.ts），30min 超时，`orchestrate:respond` 应答回灌。

---

## 四、6 节点顺序工作流编排示例（照现有 API）

基于 `buildSequential` + `buildWorkflow` + `runWorkflow`（编排 agent 给的代码范式）：

```typescript
const graph: WorkflowGraph = {
  nodes: [
    // sequential 容器（画布分组，不注册 executor）
    { id: 'content_pipeline', type: 'sequential',
      data: { label: '内容生产流水线', isEntry: true,
              participants: ['research_concurrent', 'benchmark', 'stylist', 'writer', 'imager', 'reviewer'] },
      position: { x: 0, y: 0 } },
    // A1 并发容器
    { id: 'research_concurrent', type: 'concurrent',
      data: { participants: ['research_gh','research_reddit','research_exa'], aggregator: 'research_agg' },
      position: { x: 200, y: 0 } },
    { id: 'research_gh',     type: 'agent', data: { parentId:'research_concurrent', label:'GitHub调研', sourceAgentId:'agt_research_gh', ... }, position:{x:300,y:0} },
    { id: 'research_reddit', type: 'agent', data: { parentId:'research_concurrent', label:'Reddit调研', sourceAgentId:'agt_research_reddit', ... }, position:{x:300,y:100} },
    { id: 'research_exa',    type: 'agent', data: { parentId:'research_concurrent', label:'Exa调研', sourceAgentId:'agt_research_exa', ... }, position:{x:300,y:200} },
    { id: 'research_agg',    type: 'agent', data: { parentId:'research_concurrent', label:'调研聚合', sourceAgentId:'agt_research_agg', ... }, position:{x:500,y:100} },
    // A2-A6 顺序
    { id: 'benchmark', type: 'agent', data: { parentId:'content_pipeline', label:'对标', sourceAgentId:'agt_benchmark', ... }, position:{x:600,y:0} },
    { id: 'stylist',   type: 'agent', data: { parentId:'content_pipeline', label:'固化', sourceAgentId:'agt_stylist', ... }, position:{x:800,y:0} },
    { id: 'writer',    type: 'agent', data: { parentId:'content_pipeline', label:'写稿', sourceAgentId:'agt_writer', ... }, position:{x:1000,y:0} },
    { id: 'imager',    type: 'agent', data: { parentId:'content_pipeline', label:'配图', sourceAgentId:'agt_imager', ... }, position:{x:1200,y:0} },
    { id: 'reviewer',  type: 'agent', data: { parentId:'content_pipeline', label:'review', sourceAgentId:'agt_reviewer', ... }, position:{x:1400,y:0} },
  ],
  edges: [], // 容器内线性边由 buildSequential 自动配
}
```

**执行流**：buildWorkflow → buildSequential 配 A1→A2→…→A6 线性边 → runner superstep 接力 → A1 内部 concurrent fan-out/fan-in → HITL 挂起等确认 → 收敛。

---

## 五、落地改动清单（确认后执行）

### 5.1 存储层（2 张表 + 2 个 JsonCollection + 1 个目录化）

| 改动 | 文件 | 内容 |
|------|------|------|
| 建表 v7 | `src/main/storage/db.ts` MIGRATIONS 末尾 | `topics` 表（id/user_id/title/status/tags/meta/created_at/updated_at） |
| 建表 v8 | 同上 | `reviews` 表（id/user_id/asset_type/asset_id/score/notes/created_at） |
| 选题库 CRUD | 新建 `src/main/storage/topics.ts` | 仿 sessions.ts 风格 |
| Review CRUD | 新建 `src/main/storage/reviews.ts` | 仿 sessions.ts |
| 风格画像 | `src/main/storage/models.ts` + paths.ts | `JsonCollection<StyleProfile>` + `getStyleProfilesDir()` |
| 样文目录化 | 新建 `src/main/storage/sample-articles/store.ts` | 仿 `skills/store.ts` 目录扫描；出厂源 `build/builtin/sample-articles/<id>/` 首启复制进 `config/sample-articles/<id>/`（见 §2.5） |
| 模板 builtin 复制 | `seedBuiltinAssets` 覆盖 | `build/builtin/templates/` → `config/templates/` |

### 5.2 类型 + Schema + IPC + Preload（每类资产一套）

每类知识资产按 One 现有范式走 6 个挂载点（照存储 agent §8.5 实施清单）：

1. `src/shared/types.ts` — 新增 `StyleProfile`/`Topic`/`SampleArticle`/`ReviewRecord` 接口
2. `src/main/config.ts` — 新增对应 `*Schema`/`*InputSchema`（Zod）
3. `src/main/storage/paths.ts` — 新增 `get*Dir()`/`get*Path()`
4. `src/main/storage/` — 数据层（上表）
5. `src/main/ipc/` 新文件 — `withHandler` 注册 `topics:list/get/save/remove` 等
6. `src/preload/index.ts` — `OneApi` 加白名单 + `window.one.topics.*` 等
7. `public/locales/{zh-CN,en}/` — i18n key

### 5.3 工具层（5 个新 builtin tool）

| 改动 | 文件 |
|------|------|
| exa_search | 新建 `src/main/tools/builtin/exa.ts`（范式A） |
| reddit_search | 新建 `src/main/tools/builtin/reddit.ts`（范式A） |
| gh_search | 新建 `src/main/tools/builtin/gh.ts`（范式B spawn） |
| poster_render | 新建 `src/main/tools/builtin/poster.ts`（范式B spawn Chrome） |
| review_archive_save | 新建 `src/main/tools/builtin/reviewArchive.ts`（SQLite 写） |
| ai_cavity_audit | 新建 `src/main/tools/builtin/aiCavity.ts`（纯规则，零 spawn） |
| 注册 | `src/main/index.ts:138-150` 区域加 6 个 `register*Tools()` 调用 |

### 5.4 Agent × Skill × Capability 预置

| 改动 | 文件/机制 |
|------|----------|
| 6 个 builtin Agent | 出厂源 `build/builtin/agents/*.json`，固定 id（`builtin_content_*`），首启经 `seedBuiltinAssets` 复制进 `config/agents/`（见 §2.5） |
| 6 个 Skill | 出厂源 `build/builtin/skills/<id>/SKILL.md + references/`，首启复制进 `config/skills/<id>/`（内容从原 references md 迁移；review-discipline 含 §2.5 AI腔逐句判据） |
| 1 个 Capability | 出厂源 `build/builtin/capabilities/builtin_content_pipeline.json`（§四的 graph，固定 id `builtin_content_pipeline`，**文件名必须==id**：JsonCollection.get(id) 按 `{id}.json` 读，不一致则按 id 打开/运行能力返 null），首启复制进 `config/capabilities/` |
| HTML 模板 | 出厂源 `build/builtin/templates/wechat-poster.html`，首启复制进 `config/templates/`（用户可改副本，poster_render 读 overlay：用户层有则用，无则回退 builtin） |

---

## 六、与原 skill 的关系

- 原 `~/.claude/skills/wechat-tech-content` skill **保留不动**——它仍可在 Claude Code 侧用（我刚跑通的 ponytail 那篇就是它产的）。
- 本方案是把它的能力**镜像沉淀**进 One 运行时，变成 One 产品功能。两者并存，不互斥。
- 迁移映射：原 references md → Skill content；原 scripts → builtin tool；原 assets → 知识资产表/目录；原 SKILL.md 编排逻辑 → Capability graph。

---

## 七、风险与取舍

1. **context_mode 未实现**（编排 agent 确认：home.ts L793 仅占位注释）。当前 sequential 硬编码 `full_conversation` 转发——对内容生产够用（每阶段都要看上游全貌），但长流程 cache 会膨胀。runner 有 200 条/24k token 软上限截断兜底。**不阻塞本方案，但后续 A4 writer 接收前 5 阶段全量 cache 可能超 token，需测**。
2. **A1 并发嵌套**：concurrent 容器作 sequential 首 participant，builder 已支持嵌套边界解析。但需验证 fan-in 后 research-agg → benchmark 的接力边是否正确落点。
3. **builtin tool 随包分发 vs 用户自配**：5 个新 tool 随包内置（零安装）。若用户想加小红书/搜狗微信等平台，走 MCP server（设置页自配）——builtin 只固化最常用的 GitHub/Reddit/Exa。
4. **AI腔检测**：A6 reviewer 在 review-discipline skill 内做逐句诊断（不调 `ai_cavity_score.py` 脚本）——判据吸收自 Roland《我找到了AI写作问题的根源》：审两类根源（①自造说法给事实换名字 ②英译式话语连接如"反映出"造成语法+证据双重错位），执行"删连接词分别读前后句→问前句是事实吗/后句是事实还是解释/原材料建立了这层关系吗→按支持程度重写"。比词表式检测深一层（审句子与原材料的关系，非抓常用词），且零 spawn 开销。判据随 review-checklist.md §2.5 预置进 skill content。
5. **样文存储（标准化定论）**：目录化（仿 skill，`config/sample-articles/<id>/ARTICLE.md + references/`），不用 JsonCollection。样文是 A2/A3/A4/A6 四阶段共用的风格锚点（对标拆解/风格固化/写稿套版/review 对标），必须留。随包出厂（`build/builtin/sample-articles/` 首启复制进 userData），用户可改副本、可分享。放弃"MVP 先 JsonCollection 后升级"取舍——标准化产品一步到位。
6. **A6 内闭环审改不分离（路线1 取舍，已定）**：review 与改稿同由 A6 reviewer 担任，思维不够隔离。曾评估"条件边回流 A6→A4"路线（审改分离、贴近真实生产）被否决，原因：
   - **引擎硬约束**：`hasCycle`（builder.ts:37/328）只查 `graph.edges`，sequential 容器内回路边要么被环检测拦（抛 `errors.graph.cycle`），要么作为子节点显式边被跳过（builder.ts:107-114）。要支持须改核心约束（hasCycle 跳条件边 2 行）+ 加回流计数器（防 `MAX_SUPERSTEPS=50` 兜底太松：回流每轮 3-5 次 LLM 调用，最坏 150-250 次调用 ≈ 7-12 美元、10-30 分钟才超时报错）。
   - **context_mode 未实现**（见风险1）：`full_conversation` 多轮回流触发 `CACHE_TOKEN_CAP=24000` 截断（runner.ts:331-345，保留首条+尾部窗口），A6 中间轮的 review 意见被截掉 → A4 改第二稿看不到第一轮 review → 改不对 → 再判返工 → 不收敛。
   - **条件谓词脆弱**：`contains:` 是裸子串匹配（runner.ts:452-454），靠 A6 输出固定标记（如 `[[REWORK]]`）约定防误匹配，非引擎强保证。
   - **结论**：MVP 走路线1 零引擎改动、零死循环风险（A6 在自身 tool-use 循环收敛，有 LLM 自身收敛倾向）；"审改分离"留作 context_mode 落地后的引擎增强，届时回流才有意义。

---

## 八、实施阶段（确认后分 PR）

| 阶段 | 范围 | 完成标志 | 状态 |
|------|------|---------|------|
| P0 分发基线 | §2.5 内置资产分发范式：`paths.ts` 加 `getBuiltinResourcesDir` + `electron-builder.yml` extraResources + `seedBuiltinAssets()` + 固定 id + isLocallyModified 升级 | builtin 资产随包出厂，首启落地 userData，用户可改，升级不覆盖改动 | ✅ |
| P1 存储 | 2 表 v7/v8 + StyleProfile JsonCollection + Topic/Review CRUD + 类型/Schema/IPC/Preload | 4 类资产可经 IPC 增删改查 | ✅ |
| P2 工具 | 6 个 builtin tool（exa/reddit/gh/poster/reviewArchive/ai_cavity_audit）+ 6 资产 CRUD 工具 + index.ts 注册 | agent 能调全部工具 | ✅ |
| P3 Agent×Skill | 6 个 builtin Agent（固定 id `builtin_content_*`）+ 6 个 Skill 出厂源落 `build/builtin/`，首启复制 | 画布能拖出 6 个预置 agent | ✅ |
| P4 Capability | 预置 content-pipeline Capability（固定 id `builtin_content_pipeline`）+ 端到端跑通 | 画布点运行，6 阶段接力 + HITL 挂起 + 落盘 Obsidian | ✅ 静态层（JSON 过 schema + graph 能 buildWorkflow）；端到端需真机+LLM |
| P4.1 审查修复 | ① capability 文件名==id（`builtin_content_pipeline.json`）+ 回归测试；② 目录型 builtin 资产逐子项回填（老用户升级拿得到新 builtin skill/样文）；③ 新 IPC CRUD 面入口 Zod parse（匹配 sessions.ts 约定） | 文件名/id 一致、升级分发不短路、IPC 边界结构化报错 | ✅ 508 测试 + typecheck 干净 |

---

## 九、标准化定论（原开放问题，已全部按标准化产品要求定论）

> 用户决策：标准化产品，放弃一切 MVP 取舍。内置能力随包出厂、开箱即用、用户可改、改完可分享给他人接着改。

1. **A1 并行 sub-agent**：拆 3 个独立 builtin Agent（`builtin_content_research_gh/reddit/exa`）+ 1 聚合 `builtin_content_research_agg`。符合细粒度决策，每平台一个可复用 agent，可单独编进其他工作流。
2. **样文存储**：目录化（`config/sample-articles/<id>/ARTICLE.md + references/`），不用 JsonCollection。随包出厂（`build/builtin/sample-articles/` 首启复制），用户可改副本、可分享。一步到位，不搞"MVP 先 JsonCollection 后升级"。
3. **AI腔检测**：两层——① builtin tool `ai_cavity_audit` 做规则预筛（逐句扫自造说法候选 + `反映出/体现出/表明了` 连接词位置 + 前后句关系待核），输出透明命中清单，零 LLM 成本；② A6 reviewer agent 拿预筛清单 + review-discipline §2.5 判据逐条定夺改写。规则透明可解释，LLM 判语义。`ai_cavity_audit` 作 builtin tool 随包分发。判据吸收自 Roland《我找到了AI写作问题的根源》（见 §2.4 review-discipline + 原 skill review-checklist.md §2.5）。
4. **HTML poster 模板**：出厂源 `build/builtin/templates/wechat-poster.html`，首启复制进 `config/templates/`。`poster_render` 读 overlay（用户层有则用，无则回退 builtin 原版）。不内联进工具代码（改不了）、不单落 userData（不随包分发）。
5. **预置 Agent/Capability/Skill 分发**：走 §2.5 内置资产分发范式（出厂源 `build/builtin/` → extraResources 打包 → `seedBuiltinAssets` 首启复制进 userData → 固定 id → isLocallyModified 升级）。不走纯 Registry 导入（依赖远端拉取，不"开箱即用"），不靠 source 字段区分身份（registry 链路已证实丢 source）。

---

> 以上为完整方案。**§九 已全部标准化定论，等你最终确认后进入 P0-P4 实施。不在此阶段写实现代码。**
