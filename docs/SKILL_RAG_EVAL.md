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
