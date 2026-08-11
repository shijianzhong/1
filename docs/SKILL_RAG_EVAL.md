# One — Skill RAG 召回验证

> 评测时间：2026-08-11
>
> 评测对象：当前本地已安装 skills（真实用户数据）
>
> 技能样本目录：`/Users/shijianzhong/Library/Application Support/one/config/skills`
>
> 复跑脚本：`node ./scripts/skill-rag-eval.mjs`

---

## 一、评测范围

本轮评测基于当前本地已安装的 5 个真实 skill：

| name | 描述摘要 |
|---|---|
| `wechat-tech-content` | 技术类微信公众号内容生产闭环，覆盖选题调研 → 对标拆解 → 初稿写作 → 配图落盘 |
| `tech-research` | 技术内容选题调研 |
| `content-teardown` | 对标拆解 |
| `wechat-writing` | 微信公众号写作 |
| `content-review` | 内容审稿 / 质量门禁 |

评测 query 共 12 条，覆盖四类任务：

1. 闭环总控类
2. 子阶段明确任务类
3. 同域相近技能区分类
4. 模糊口语化表达类

---

## 二、当前实现口径

本次评测对应的是当前 `skill_search` 的实际策略：

1. `name` 精确 / 前缀匹配，权重 3
2. FTS5 BM25，权重 2
3. `name/description/content_tokenized` 的 LIKE 兜底，权重 1

说明：

- 评测脚本 `scripts/skill-rag-eval.mjs` 复刻的是当前仓库内 `src/main/storage/skills/fts.ts` 的检索逻辑
- 由于主数据来自真实本地 skill JSON，因此这轮结果可以作为第一版实证基线

---

## 三、指标结果

| 指标 | 结果 |
|---|---|
| Primary Top1 | 10/12（83.3%） |
| Primary Top3 | 10/12（83.3%） |
| Primary Top5 | 12/12（100.0%） |
| Relaxed Top1 | 11/12（91.7%） |
| Relaxed Top3 | 11/12（91.7%） |
| Relaxed Top5 | 12/12（100.0%） |

口径说明：

- **Primary**：严格按“主目标 skill”计分
- **Relaxed**：对少数天然歧义 query，允许“闭环总 skill”与“子阶段 skill”都算合理答案

---

## 四、明细

| 场景 | query | 期望主目标 | 实际 Top1 | Top3 | 结论 |
|---|---|---|---|---|---|
| 闭环总控 | 帮我做技术公众号内容生产闭环 | `wechat-tech-content` | `wechat-tech-content` | `wechat-tech-content` / `content-review` / `content-teardown` | 命中 |
| 选题调研-全网 | 帮我做全网技术选题调研 | `tech-research` | `tech-research` | `tech-research` / `wechat-tech-content` / `content-teardown` | 命中 |
| 选题调研-推荐 | 选 3 个高价值技术选题 | `tech-research` | `tech-research` | `tech-research` / `wechat-tech-content` / `content-teardown` | 命中 |
| 对标拆解 | 做公众号对标拆解 | `content-teardown` | `content-review` | `content-review` / `wechat-tech-content` / `wechat-writing` | 未命中 |
| 结构逆向 | 拆解同类技术号标题公式和 6 段式结构 | `content-teardown` | `content-teardown` | `content-teardown` / `wechat-tech-content` / `wechat-writing` | 命中 |
| 公众号写作 | 按风格模板写一篇技术公众号深度文 | `wechat-writing` | `wechat-writing` | `wechat-writing` / `wechat-tech-content` / `content-teardown` | 命中 |
| 写作配图落盘 | 产出公众号初稿并配图落盘 | `wechat-writing` | `wechat-writing` | `wechat-writing` / `wechat-tech-content` / `content-review` | 命中 |
| 内容审稿 | 对这篇内容做审稿打分 | `content-review` | `content-review` | `content-review` / `wechat-tech-content` / `wechat-writing` | 命中 |
| 质量门禁 | 不通过就返工的内容审稿 | `content-review` | `content-review` | `content-review` / `wechat-tech-content` / `wechat-writing` | 命中 |
| 码农号生产 | 给码农知道的事这类技术号生产内容 | `wechat-tech-content` | `wechat-tech-content` | `wechat-tech-content` / `content-teardown` / `content-review` | 命中 |
| 完整一条龙 | 从选题到写作一条龙做技术公众号 | `wechat-tech-content` | `wechat-tech-content` | `wechat-tech-content` / `content-teardown` / `wechat-writing` | 命中 |
| 技术公众号写作 | 技术公众号写作 | `wechat-writing` | `wechat-tech-content` | `wechat-tech-content` / `content-teardown` / `content-review` | 未命中 |

---

## 五、错例分析

### 1. `做公众号对标拆解`

- 期望：`content-teardown`
- 实际 Top1：`content-review`

初步判断：

- `content-review` 的描述中带有“对标对比”
- query 同时包含“公众号”和“对标”，而 `content-teardown` 当前描述更强调“技术号 / 标题公式 / 6段式结构”，没有显式覆盖“公众号”这个词
- `wechat-tech-content` 又带有较强的“公众号”上下文，因此把 `content-teardown` 往后挤

结论：

- 这是 **子阶段 skill 的场景词不够全**，不是“完全搜不到”的问题

### 2. `技术公众号写作`

- 期望：`wechat-writing`
- 实际 Top1：`wechat-tech-content`

初步判断：

- `wechat-writing` 强调“微信公众号写作”，但缺少“技术公众号”这层域信息
- `wechat-tech-content` 同时覆盖“技术 + 微信公众号 + 内容生产”，在宽 query 下天然更占优势

结论：

- 这是 **闭环总 skill 与子阶段 skill 的语义边界竞争**
- 在 strict 口径下算 miss，但从 relaxed 视角看并不离谱

---

## 六、结论

### 6.1 当前方案是否可用

**可用。**

在这批真实 skill 上：

- Primary Top1 = 83.3%
- Top5 = 100%

这说明当前 `name + description + FTS + LIKE` 的基础方案已经具备落地价值，主问题不是“召回失败”，而是：

1. 同域高度相似 skill 的排序边界
2. 闭环总 skill 与子阶段 skill 的竞争

### 6.2 当前最值得做的优化

优先级从高到低建议如下：

1. **补 description / tags 的场景词**
   - 尤其是子阶段 skill，要补上“技术公众号”“公众号对标拆解”“技术内容写作”这类用户真实会说的话
2. **为 skill 增加可选 tags 字段**
   - 例如：`domain=tech-content`、`stage=research|teardown|writing|review`
   - 检索时把 tags 一并入 FTS 或作为额外权重
3. **后续再考虑调权重**
   - 当前权重不是首要瓶颈
   - 没补词之前，单纯调权重容易把一个错例修好、另一个错例打坏

### 6.3 暂时不建议做的事

- 暂时**不建议**因为这两条错例就重写检索逻辑
- 也**不建议**过早上复杂 rerank

当前阶段更划算的是：

- 先补技能元信息
- 再用同一脚本复跑
- 看 Top1 是否从 83% 稳定拉到 90%+

---

## 七、后续建议

下一轮建议分两步：

1. 给这 5 个 skill 补更贴近真实用户表达的 description / tags
2. 继续装入几类**跨域** skill，再跑一次同样的评测

原因是这轮样本几乎都在同一条“技术公众号内容生产闭环”内，当前结果更能说明“同域技能能否拉开”，还不能充分说明“跨域技能是否会误召回”。

如果下一轮跨域样本依然稳定，那这套 Skill RAG 就基本站住了。
