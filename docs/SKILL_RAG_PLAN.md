# One — Skill 按需检索改造方案（RAG）

> **目标**：主 agent 默认拥有“检索全部已安装 skill”的能力，但不把 SKILL.md 全文常驻塞进 prompt；改为「零广告清单 + FTS 检索工具按需取回」，解决成百上千 skill 量级下的 prompt 膨胀问题。
>
> **状态**：已完成代码核验并吸收修订，待实现。实现后同步进 `task.md`。
>
> **关联铁律**：§22（Skill = ContextProvider，`beforeRun` 注入）；§21（L3 走工具按需检索不硬塞 prompt——本方案把该范式迁移到 skill）。
>
> **参考**：源框架 `agent-framework-main/python/packages/core/agent_framework/_skills.py` 的 progressive-disclosure 三段式（Advertise / Load / Read resource）。

---

## 一、代码事实与问题定义

### 1.1 当前实现事实

当前 skill 进入 agent 的主通道是 `SkillContextProvider.beforeRun({ skillIds })`。`buildSkillXmlBlock()` 会把 skill 的 `content` inline 成 `<skill>` XML 块拼进 `instructions`，单 skill 限长 `SKILL_CONTENT_LIMIT = 24000` 字，超长硬截断。

代码依据：

- `src/main/skills/provider.ts:15` — `SKILL_CONTENT_LIMIT = 24000`
- `src/main/skills/provider.ts:25-35` — `buildSkillXmlBlock()`
- `src/main/skills/provider.ts:91-118` — `beforeRun()` 直接把 skill 全文拼进 instructions

主 agent 的注入点在 `src/main/ipc/home.ts:286-317`，当前 skill 来源只有两路：

1. `persona?.skillIds`
2. `mentions.skills`

而 Settings 页对 `persona.skillIds` 目前只有透传，没有可编辑 UI，因此主 agent 实际上几乎只能靠用户显式 `@技能` 才能吃到 skill。

代码依据：

- `src/main/ipc/home.ts:286-302` — 首页主 agent 的 skill 注入
- `src/renderer/src/pages/SettingsPage.tsx:117-125` — `skillIds` 只是原样回存

### 1.2 当前痛点

| 维度 | 问题 |
|---|---|
| 可发现性 | 主 agent 不感知未 `@` 的 skill，用户得先知道 skill 名才能触发 |
| token 成本 | skill 全文 inline 时成本与 skill 数线性增长，10 个以上就会明显压缩上下文预算 |
| 量级预期 | Registry 目标是持续累积 skill；一旦来到几百上千规模，任何“常驻列清单”方案都会失效 |

### 1.3 为什么不走“广告清单 + load”中间方案

曾考虑“常驻 name+description 广告清单 + `load_skill` 按需加载”的渐进披露方案。这个模式在 10–30 个 skill 时还可接受，但在 1000 个 skill 量级下，广告清单本身就会变成巨大的 prompt 负担。

因此这里直接选择 **零广告**：不列 skill 名单，只告诉模型“你可以按需搜”。

---

## 二、总体方案

### 2.1 设计原则

迁移 L3 memory 已验证过的三件套：

1. FTS 检索
2. 工具按需取回
3. system prompt 里的策略指令激活

主 agent 的 system prompt **不列 skill 清单**，只给数量 N 和调用策略；LLM 需要时先 `skill_search`，命中后再 `load_skill`。

| 范式 | L3 memory（已实现） | skill（本方案） |
|---|---|---|
| prompt 里的内容 | 不列记忆条目，只给策略指令 | 不列 skill 清单，只给策略指令 |
| 检索工具 | `memory_search`（FTS5 + key + LIKE 三路召回） | 新增 `skill_search`（name + FTS + LIKE 三路召回） |
| 取回工具 | `memory_recall`（按 key 取回） | 新增 `load_skill`（按 id 取回完整说明） |
| 激活策略 | `buildMemoryInstruction()`（`src/main/orchestrator/home.ts:353-372`） | 新增 `buildSkillInstruction()` |
| 中文分词 | `tokenizeForFts()`（单字 + bigram） | 直接复用 |

### 2.2 改造后的主 agent 注入

```text
system prompt =
  L0 人设
  + L1 会话摘要
  + L2 跨会话摘要
  + L3 记忆策略指令
  + Skill 检索策略指令
    "你当前可按需检索 N 个技能（不列清单）。
     遇到写作/设计/数据处理/自动化类任务时，
     先 skill_search，再用 load_skill 取完整说明。"

工具：
  skill_search({ keywords, limit? }) -> [{ id, name, desc }]
  load_skill({ id })                 -> { id, name, content, discipline?, scripts? }
  skill_run_script(...)             -> 已有
```

这里刻意让 `load_skill` 走 **`id` 精确取回**，原因有两点：

1. `skill_search` 已经返回 id，链路天然顺手
2. 当前 skill 没有“名称唯一”约束，按 name 取回容易歧义

同时，`load_skill` 返回的是 `scripts?: string[]`，而不是裸 `scriptPath`。因为运行时真正需要的是“可供模型调用的脚本相对路径清单”，不是磁盘绝对路径；`skill_run_script` 也正是按 skill 名 + 相对脚本路径工作。

### 2.3 三处注入点的分工

| 注入点 | 数据对象 | skill 注入方式 | 结论 |
|---|---|---|---|
| 首页主 agent（`src/main/ipc/home.ts`） | Persona / 当前对话 | **纯 RAG**：策略指令 + 检索工具 | 改 |
| 首页组队节点（`src/main/orchestrator/home.ts`） | 节点 data | **保留全文 inline** | 不动 |
| 编辑器跑图（`src/main/ipc/orchestrate.ts`） | 节点 data | **保留全文 inline** | 不动 |

分工理由：

- 组队节点 / 编辑器节点上的 skill 是用户显式勾选的，数量有限、语义明确，全文 inline 最省心
- 主 agent 面向“全部已安装 skill”，必须换成 RAG

### 2.4 `@技能` 语义保持不变

`@技能` 是用户显式指定“就用这个 skill”。因此这里继续保留全文 inline，不走 RAG。

也就是说：

- 默认主 agent：RAG
- 用户 `@技能`：直接全文注入

两条路径并存，不冲突。

---

## 三、实现细节

### 3.1 `skill_search` 工具

参考 `memory_search` 的范式，但显式去掉 L3 的 key 路径，因为 skill 没有结构化 key。

- **索引字段**：`name + description + content`
- **召回三路**：
  1. `name` 精确 / 前缀匹配，权重 3
  2. FTS5 BM25，权重 2
  3. `content` / `description` LIKE 子串兜底，权重 1
- **参数**：`{ keywords: string, limit?: number }`，默认 8
- **返回**：`[{ id, name, desc }]`
- **失败**：返回错误 JSON，不抛异常

### 3.2 `load_skill` 工具

`load_skill` 的职责不是做搜索，而是把一个已经命中的 skill 完整取回来给模型使用。

- **参数**：`{ id: string }`
- **返回**：
  - `id`
  - `name`
  - `content`
  - `discipline?`
  - `scripts?: string[]`
- **失败**：skill 不存在时返回结构化错误 JSON，带 `errors.*` i18n key

这里不直接返回 `scriptPath`，因为：

1. 绝对路径对模型没有意义
2. 暴露磁盘路径会把运行时实现细节泄漏给提示词
3. 现有 `skill_run_script` 工具本来就只需要相对脚本路径

### 3.3 FTS 索引层

**存储位置**：复用现有 SQLite（`src/main/storage/db.ts` 打开的那份库），新增 `skills_fts`。

理由：

- 少一份 db 文件和连接管理
- `tokenizeForFts()` 已经验证可用
- skill 主数据继续存 JSON；SQLite 只承担检索索引

**建表位置**：DDL 放进 `src/main/storage/db.ts` 的 `MIGRATIONS`，追加 v4。不要在 `skills/fts.ts` 自己偷偷建表。

**表结构**：

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  skill_id UNINDEXED,
  name,
  description,
  content_tokenized,
  tokenize='unicode61'
);
```

说明：

- 这里是 **contentful FTS5**
- 与现有 `memory_l3_fts` 的真实用法一致
- 写入前对 `content_tokenized` 做 `tokenizeForFts()` 预分词

**文件分工**：

- `src/main/storage/db.ts` — migration v4
- `src/main/storage/skills/fts.ts` — `upsertSkillFts` / `deleteSkillFts` / `searchSkills` / `reindexSkillsFts`

### 3.4 `buildSkillInstruction`

参考 `buildMemoryInstruction()`（定义在 `src/main/orchestrator/home.ts:353-372`），为主 agent 注入一段简短但强行为导向的 system 指令：

```text
【可用技能】
你当前可按需检索 N 个技能（不列清单）。
- 遇到写作/设计/数据处理/自动化类任务时，先用 skill_search 搜相关技能。
- 命中后用 load_skill 读取完整说明，再按该技能要求执行。
- 闲聊、通用问答、无需专门流程时不要调用。
- 用户 @提及的技能已直接注入，无需再 load。
```

这段策略指令是必须的。否则工具再强，也会像早期 L3 一样长期处于“模型看见了但不会主动用”的死档状态。

### 3.5 主 agent 的来源调整

首页主 agent 不再通过 `persona.skillIds` 挂整段 skill 正文；改为：

1. 用 `countSkills()` 取当前已安装 skill 数量 N
2. 把 `buildSkillInstruction(N)` 拼进主 agent instructions
3. `mentions.skills` 继续走全文 inline

这意味着：

- **主 agent 的“默认拥有全部 skill 能力”不再依赖 `persona.skillIds`**
- `persona.skillIds` 在首页路径上不再承担默认挂载职责

兼容策略：

- 第一阶段可以先保留 `persona.skillIds` 字段，避免迁移 UI/数据
- 但在首页运行时不再用它做默认全文注入

### 3.6 工具暴露范围

这里有一个实现边界要先说清：

- 当前 `listToolsForAgents()` 同时服务首页主 agent 和编排节点
- 因此只要把 `skill_search` / `load_skill` 注册进 agent 工具列表，组队节点和编辑器节点理论上也会“看见”这两个工具

本方案在这里**明确选择方案 2**：

- `skill_search` / `load_skill` **全局注册**
- 首页主 agent 额外注入 `buildSkillInstruction()`，因此会把这两个工具当成默认能力来主动使用
- 组队节点 / 编辑器节点**不注入该策略指令**，继续以 inline skill 为主；它们“可以用”，但默认“不依赖”

这样处理的好处是：

1. 能力面完整，任何 agent 都不会因为工具分发差异而“理论上应该能做、实际上拿不到”
2. 组队/编辑器仍保留当前最直接的 inline 路径，不强迫它们为显式绑定 skill 再走一次检索
3. 后续如果某些复杂节点真的需要临时二次检索 skill，也不用再改工具分发层

对应的行为约定是：

| 场景 | 是否可见 `skill_search/load_skill` | 默认是否主动使用 | skill 主路径 |
|---|---|---|---|
| 首页主 agent | 是 | 是（由 `buildSkillInstruction()` 激活） | RAG |
| 首页组队节点 | 是 | 否 | inline |
| 编辑器跑图节点 | 是 | 否 | inline |

因此，这里不是“home-only 工具”，而是“**全局可见，按提示词策略区分主路径**”。

### 3.7 `countSkills()` 与启动自检

#### `countSkills()`

不能直接调用 `listSkills().length`，因为当前 `JsonCollection.list()` 会把目录下所有 JSON 全部读出来、解析成完整 `Skill[]`，其中包含 `content` 全文。

所以需要一个轻量版本：

- 只数 `skills/` 目录下的 `*.json`
- 不反序列化 `content`

#### 启动自检

不能复用 L3 那种 “SQL 表行数 vs FTS 行数” 的比对方式，因为：

- L3 主数据和 FTS 都在 SQLite
- skill 主数据在 JSON 文件，FTS 在 SQLite

因此这里要单独做：

1. 启动时扫描 `skills/` 目录下 JSON 文件数
2. 查询 `skills_fts` 行数
3. 不一致就 `reindexSkillsFts()`

1000 个 skill 量级下，全量重建 FTS 仍然是可接受的启动成本。

### 3.8 双写同步接入点

FTS 同步必须挂在 `saveSkill()` / `removeSkill()` 上，而不是 `upload.ts`。

原因：

- `parseSkillZip()` 只负责解析，不落盘
- `uploadSkillFile()` 也只返回解析结果，调用方再决定是否 `saveSkill()`
- 手动上传和 Registry 导入最终都收口到 `saveSkill()`

实际写入路径至少有两条：

1. `src/main/ipc/skills.ts` → `skills:save` → `saveSkill()`
2. `src/main/registry/importer.ts` → `saveSkill()`

因此 `saveSkill()` / `removeSkill()` 才是唯一不漏的双写挂点。

---

## 四、description 策略

`description` 对召回质量确实重要，但**不建议把它作为第一阶段硬阻塞项**。

当前更稳妥的策略是：

1. 第一阶段保持 `Skill.description` 可选
2. 建索引时对空 description 运行时 fallback，例如取 content 前若干字符
3. 上传 / 导入链路尽量补全 description
4. 等 P6 真实召回率验证后，再决定是否升成必填字段

这样能把“RAG 机制验证”和“资产规范治理”拆开，避免把第一阶段做重。

---

## 五、收益对比

| 场景 | 改造前 | 改造后 |
|---|---|---|
| 主 agent 面对 1000 skill | 不可行，prompt 直接膨胀 | 常驻 prompt 只多一段短策略指令 |
| LLM 主动发现 skill | 不会，除非用户 `@` | 可以按任务关键词主动检索 |
| 取 skill 正文 | 常驻占用 prompt | 命中后按需取回 |
| `@技能` 体验 | 全文 inline | 保持不变 |

---

## 六、文件影响

### 新增

- `src/main/storage/skills/fts.ts`
- `src/main/tools/builtin/skillSearch.ts`
- `src/main/tools/builtin/skillLoad.ts`
- `src/main/storage/skills/fts.test.ts`

### 修改

- `src/main/storage/db.ts` — migration v4 建 `skills_fts`
- `src/main/storage/models.ts` — `countSkills()` + `saveSkill()` / `removeSkill()` 挂 FTS
- `src/main/ipc/home.ts` — 主 agent 改为“数量 N + 策略指令 + @技能 inline”
- `src/main/skills/upload.ts` — description 兜底 / 校验
- `src/main/orchestrator/home.ts` 或独立文件 — `buildSkillInstruction()`
- 工具分发层 — 若采用 home-only 暴露，需要补对应收口

### 不动

- `src/main/skills/provider.ts` — 继续服务 `@技能`、组队节点、编辑器节点
- `src/main/tools/builtin/skillScript.ts` — 保持现有 async 脚本执行
- `src/main/orchestrator/runner.ts`
- `src/main/orchestrator/agent.ts`

---

## 七、风险与待确认

1. **FTS 召回质量**：真实 skill 数据下是否够准，需要用样本集验证。
2. **工具调用频率**：策略指令若写得太宽，模型可能每轮都搜；需要通过日志调 prompt。
3. **索引漂移**：JSON 与 SQLite 双存储天然存在漂移风险，靠 `save/remove` 挂钩 + 启动自检兜底。
4. **工具暴露范围**：是否首期就做 home-only 暴露，需要在实现前定掉。
5. **description 治理力度**：首期只做 fallback，还是顺手加强上传校验，需要结合真实 skill 存量决定。
6. **i18n**：`skill_search` / `load_skill` 新错误码需补到 `errors.*`。

---

## 八、分阶段落地

- [ ] P1：FTS 索引层——`db.ts` migration v4 + `storage/skills/fts.ts` + 单测，复用 `tokenizeForFts`
- [ ] P2：`skill_search` / `load_skill` 工具实现与测试，`load_skill` 走 `{ id } -> { content, discipline, scripts }`
- [ ] P3：`countSkills()` + `buildSkillInstruction()` + 首页主 agent 注入改造
- [ ] P4：`saveSkill()` / `removeSkill()` 挂钩 FTS + 启动自检 + `reindexSkillsFts()`
- [ ] P5：description fallback / 上传校验 / 是否 home-only 工具暴露 的实现收口
- [ ] P6：真实 skill 数据召回率验证 + 策略指令调优
