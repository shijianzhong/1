# Skill RAG 召回验证

- 日期：2026-08-12
- 样本来源：`/Users/shijianzhong/Library/Application Support/one/config/skills`
- skill 数量：65
- 评测 query 数量：22
- 当前口径：**离线检索层评测**（对应主 agent 的 `skill_search` 能力），不含真实 LLM 是否主动调用工具的端到端行为。

## 指标

| 指标 | 结果 |
|---|---|
| Primary Top1 | 17/22 (77.3%) |
| Primary Top3 | 19/22 (86.4%) |
| Primary Top5 | 20/22 (90.9%) |
| Relaxed Top1 | 19/22 (86.4%) |
| Relaxed Top3 | 20/22 (90.9%) |
| Relaxed Top5 | 21/22 (95.5%) |

## 明细

| 场景 | query | 期望主目标 | Top1 | Top3 | Primary Top1 | Relaxed Top3 |
|---|---|---|---|---|---|---|
| 公众号闭环 | 帮我做技术公众号内容生产闭环 | `wechat-tech-content` | `wechat-tech-content` | wechat-tech-content / content-review / content-teardown | ✅ | ✅ |
| 选题调研 | 帮我做全网技术选题调研，给 3 个高价值方向 | `tech-research` | `tech-research` | tech-research / wechat-tech-content / content-teardown | ✅ | ✅ |
| 对标拆解 | 拆解 3 个同类技术号的标题公式和结构套路 | `content-teardown` | `content-teardown` | content-teardown / wechat-tech-content / tech-research | ✅ | ✅ |
| 公众号写作 | 按技术号风格模板写一篇微信公众号深度文 | `wechat-writing` | `wechat-tech-content` | wechat-tech-content / wechat-writing / content-teardown | ❌ | ✅ |
| 内容审稿 | 对这篇文章做审稿打分，不通过就返工 | `content-review` | `content-review` | content-review / wechat-tech-content / content-teardown | ✅ | ✅ |
| 公众号排版 | 把 Markdown 转成公众号 HTML | `md2wechat` | `wechat-tech-content` | wechat-tech-content / md2wechat / baoyu-post-to-wechat | ❌ | ✅ |
| 发布公众号 | 把这篇文章发布到微信公众号草稿箱 | `baoyu-post-to-wechat` | `baoyu-post-to-wechat` | baoyu-post-to-wechat / wechat-tech-content / md2wechat | ✅ | ✅ |
| 品牌手册 | 帮我做一个高端品牌手册和视觉规范板 | `brandkit` | `brandkit` | brandkit / lark-openapi-explorer / dashen-x-battle-plan | ✅ | ✅ |
| 前端重设计 | 重做现有网站，让质感更高级但不破坏功能 | `redesign-existing-projects` | `redesign-existing-projects` | redesign-existing-projects / lark-openapi-explorer / lark-skill-maker | ✅ | ✅ |
| 设计审美增强 | 把这个前端界面打磨得更有设计感 | `impeccable` | `impeccable` | impeccable / webapp-quality-gate / wechat-tech-content | ✅ | ✅ |
| 飞书文档 | 帮我创建飞书文档并插入图片 | `lark-doc` | `lark-doc` | lark-doc / lark-whiteboard / lark-task | ✅ | ✅ |
| 飞书联系人 | 查一下同事的 open_id 和联系方式 | `lark-contact` | `lark-contact` | lark-contact / agent-reach / lark-mail | ✅ | ✅ |
| 日程待办摘要 | 生成一份今天的日程和待办摘要 | `lark-workflow-standup-report` | `lark-workflow-standup-report` | lark-workflow-standup-report / lark-calendar / lark-vc | ✅ | ✅ |
| 创建日程 | 帮我在飞书日历里创建一个明天下午的会议 | `lark-calendar` | `lark-calendar` | lark-calendar / lark-workflow-standup-report / lark-workflow-meeting-summary | ✅ | ✅ |
| 电子表格 | 创建一个飞书电子表格并写入表头和数据 | `lark-sheets` | `lark-sheets` | lark-sheets / lark-doc / lark-drive | ✅ | ✅ |
| 会议纪要汇总 | 整理本周会议纪要并生成结构化周报 | `lark-workflow-meeting-summary` | `lark-workflow-meeting-summary` | lark-workflow-meeting-summary / lark-vc / lark-minutes | ✅ | ✅ |
| X 作战计划 | 帮我做一个 X 账号内容作战计划 PDF | `dashen-x-battle-plan` | `dashen-x-battle-plan` | dashen-x-battle-plan / wechat-tech-content / vue-init | ✅ | ✅ |
| Vue 脚手架 | 做一个 Vue 3 脚手架项目 | `vue-init` | `vue-init` | vue-init / tech-research / wechat-tech-content | ✅ | ✅ |
| Web 测试 | 帮我测试本地 web 应用页面交互 | `webapp-testing` | `webapp-quality-gate` | webapp-quality-gate / dashen-x-battle-plan / wechat-tech-content | ❌ | ✅ |
| GitHub 知识库 | 帮我建立一个 GitHub 仓库知识库并支持搜索 | `github-kb` | `github-kb` | github-kb / tech-research / agent-reach | ✅ | ✅ |
| 创建 Skill | 帮我创建一个新的 agent skill | `skill-creator` | `agent-reach` | agent-reach / lark-task / vue-init | ❌ | ❌ |
| 找 Skill | 帮我找一个能完成这个任务的 skill | `find-skills` | `lark-task` | lark-task / agent-reach / lark-workflow-standup-report | ❌ | ❌ |

## 错例与观察

- **公众号写作**：query=`按技术号风格模板写一篇微信公众号深度文`
  - 期望主目标：`wechat-writing`
  - 可接受目标：`wechat-writing` / `wechat-tech-content`
  - 实际 Top3：`wechat-tech-content` / `wechat-writing` / `content-teardown`
- **公众号排版**：query=`把 Markdown 转成公众号 HTML`
  - 期望主目标：`md2wechat`
  - 可接受目标：`md2wechat` / `baoyu-post-to-wechat`
  - 实际 Top3：`wechat-tech-content` / `md2wechat` / `baoyu-post-to-wechat`
- **Web 测试**：query=`帮我测试本地 web 应用页面交互`
  - 期望主目标：`webapp-testing`
  - 可接受目标：`webapp-testing` / `webapp-quality-gate`
  - 实际 Top3：`webapp-quality-gate` / `dashen-x-battle-plan` / `wechat-tech-content`
- **创建 Skill**：query=`帮我创建一个新的 agent skill`
  - 期望主目标：`skill-creator`
  - 可接受目标：`skill-creator`
  - 实际 Top3：`agent-reach` / `lark-task` / `vue-init`
- **找 Skill**：query=`帮我找一个能完成这个任务的 skill`
  - 期望主目标：`find-skills`
  - 可接受目标：`find-skills`
  - 实际 Top3：`lark-task` / `agent-reach` / `lark-workflow-standup-report`

## 初步结论

- 当前检索层已经基本可用；在本轮 22 个 query 中，除 5 个已知错例外，其余样本均达到预期范围。
- `description + tags` 对目录化 skill 池是有效信号，已经把 `Primary Top1` 从 `59.1%` 拉升到 `77.3%`。
- 本轮 skill 池已经从早期少量闭环 skill 扩展到 60+，旧评测口径不再成立，后续应继续按当前目录化 skill 池复测。
- 下一步重点不再是补基础设施，而是按需要微调 `skill_search` 排序策略，并在合适时机补真实主 agent 跑批验证。

---

## 重调结果（2026-08-20，P3 前置）

> 背景见 `docs/VECTOR_KB_PLAN.md` §八 P3 + §九 风险10：给 skills 搜索加向量前，先零成本调排序权重 + 22 条复测，确有余量才上向量。

### 对照基线（关键：同池 A/B）

上表的 77.3% (Primary Top1) 是 **65-skill 旧池 + 旧 skill 命名**的口径；当前池已重整为 66 个目录化 skill（大量「…纪律」命名），旧口径不可直接对比。本次重调在同一 **66-skill 当前池** 上做受控 A/B（`scripts/skill-rag-eval.mjs` 同一 corpus、同一 22 query、仅 `searchSkills` 实现不同）：

| 实现 | Primary Top1 | Primary Top3 | Relaxed Top3 | 说明 |
|---|---|---|---|---|
| **原 ranking**（同池基线） | 13/22 (59.1%) | 13/22 (59.1%) | 16/22 (72.7%) | 当前池的真实原口径 |
| 全量重调（token name/tag + bm25 列权） | 10/22 (45.5%) | 15/22 (68.2%) | 18/22 (81.8%) | Top3/relaxed 召回 +9pp，**Top1 回归 -13.6pp** |
| bm25 列权降回 `ORDER BY rank` | 11/22 (50.0%) | 15/22 (68.2%) | 18/22 (81.8%) | bm25 列权是 Top1 回归主因之一 |
| **采用：escape 修 + 原 ranking** | 13/22 (59.1%) | 13/22 (59.1%) | 16/22 (72.7%) | latent bug 修，行为对 22 query 中性 |

### 失败逐例观察（全量重调为何回归 Top1）

核心病根：token 子串 name 通道 + bm25 name 列权 10.0 过度加权 **CJK 命名「…纪律」类 skill**——它们的 name 含 query bigram（如「选题调研纪律」含「选题」「调研」），拿到 3.0 name 权 + bm25 name 列高分；而真目标常是 **ASCII 名**（`tech-research`/`md2wechat`/`skill-creator`），与 CJK query 零 token 共享，只在 content 列有分 → 被压到 Top2/3。

| query | 真目标 | 全量重调 Top1 | 病根 |
|---|---|---|---|
| 帮我做技术公众号内容生产闭环 | `wechat-tech-content` | `选题调研纪律` | CJK 名含「内容」bigram |
| 拆解同类技术号标题公式 | `content-teardown` | `对标拆解纪律` | CJK 名含「拆解」 |
| 按技术号风格写公众号深度文 | `wechat-writing` | `风格固化纪律` | CJK 名含「风格」 |
| 帮我创建一个新的 agent skill | `skill-creator` | `find-skills` | ASCII 名间互抢（find-skills 含 "skill" 子串） |

### 决策：保留原 ranking + 只留 latent bug 修

- **采用**：`escapeLikePattern` 修 LIKE/tag 通道通配符注入 latent bug（query 含 `%`/`_` 原被当通配符 → 全表扫拖慢主进程 + 噪声）+ `buildMatchQuery` DRY 复用 `l3.ts`（与 L3/kb-fts 单一真相源）。行为对 22 query 完全中性（均不含 `%`/`_`），是纯正确性修。
- **不采用**：token-based name/tag 通道、bm25 列加权——均在真实池回归 Primary Top1，不符「Top1 ≥ before 且失败改善」安全门，回退。
- 回归门：`src/main/storage/skills/search-skills.test.ts`（import 生产 `searchSkills`，drift-free），锁 latent bug 修 + 原排名不回归。

### go/no-go：P3 向量暂缓

- retuned FTS（采用版）Primary Top1 **59.1%** vs vector baseline（`kb-spike.mjs`，multilingual-e5-small）Primary Top1 **36.4%** / Relaxed Top3 **50%**——词法仍显著超向量。
- 决策规则命中：retuned FTS Top1 > vector baseline **且** Relaxed Top3 > vector baseline → **P3（给 skills 搜索加向量）暂缓**。
- 真实瓶颈不是「词法 vs 向量」，而是 **CJK 命名「纪律」类 skill 与 ASCII 命名真目标之间的 ranking 冲突**——这是数据/命名问题，向量也解不了（向量对短 name 同样弱，见 P0 spike 结论）。后续若要推进，优先级是：① skill 命名规范化（让真目标 name 含可被 query 词命中片段）② 主 agent 端到端跑批验证 ③ 再考虑向量。
- 范围确认：无 `skills_vec` 迁移、无 sidecar 表、无 hybrid skills 搜索代码（`grep "skills.*vec" src/main/storage/db.ts` 仅 `app_meta` 行）。
