# One — Skill 标准目录化改造方案

> 日期：2026-08-11
>
> 目标：放弃当前 `*.json` 作为 Skill 主存储的做法，改为与外部 Skill 生态一致的目录化标准格式。
>
> 范围：**不兼容旧 Skill JSON**。只保留新的目录化结构，不做读旧数据、自动迁移、双写兼容。

---

## 一、结论

这次改造是**值得做**的，而且从代码事实看，当前项目已经有一半链路天然偏向 `SKILL.md` 世界：

- 外部导入入口本来就是 `SKILL.md + references/scripts/assets`
- Registry 导出本来就会生成 `SKILL.md`
- Skill ContextProvider 的语义核心也是 `SKILL.md` 内容，而不是 JSON 文件本身

真正落后的只是**运行时本地安装格式**仍然是：

- `userData/config/skills/{id}.json`
- 可选 `userData/config/skills/{id}/scripts|references|assets`

所以这次改造的本质不是“另起炉灶”，而是把**外部格式、Registry 格式、运行时格式统一**。

---

## 二、代码事实

### 2.1 当前 Skill 主存储仍是 JSON

当前主数据源明确是 `userData/config/skills/{id}.json`：

- `src/main/storage/models.ts`
  - `skillsStore = new JsonCollection<Skill>(getSkillsPath(), ...)`
  - `listSkills()/getSkill()/saveSkill()/removeSkill()` 全都围绕 JSON 工作

这意味着：

1. Skills 列表页读 JSON
2. 首页/编排注入 Skill 读 JSON
3. `skill_search/load_skill` 的 RAG 主数据也最终来自 JSON

### 2.2 当前外部导入格式已经是目录型 Skill

`src/main/skills/upload.ts` 已经在按标准 Skill 包思路工作：

1. ZIP 内找 `SKILL.md`
2. 解析 frontmatter + 正文
3. 提取 `references/`、`assets/`、`scripts/`
4. 再把解析结果转存成内部 JSON

这说明项目并不缺“读标准 Skill 包”的能力，缺的是“**直接把标准 Skill 包作为最终存储**”。

### 2.3 当前运行时强依赖 `scriptPath`

这是本次改造里最需要正面处理的一点。

当前多处逻辑通过 `skill.scriptPath` 来反推出 skill 根目录或 scripts 目录：

- `src/main/skills/provider.ts`
  - `resolveScriptsDir(scriptPath)`
  - `listSkillScripts(skill)`
- `src/main/tools/builtin/skillScript.ts`
  - `skill_run_script` 通过 `skill.scriptPath` 解析脚本目录
- `src/main/registry/exporter.ts`
  - `buildSkillZip()` 通过 `scriptPath` 反查解压目录
- `src/main/registry/importer.ts`
  - 更新 skill 时靠 `scriptPath` 找旧目录并清理

所以如果去掉 JSON，就不能只“换个存储路径”，必须把 `scriptPath` 这条链整体换掉。

### 2.4 当前前端页也把 Skill 当成“内容字段 + scriptPath”

`src/renderer/src/pages/SkillsPage.tsx` 现在的编辑模型是：

- `name`
- `description`
- `content`
- `scriptPath`

也就是说，前端当前编辑的是“JSON 投影”，不是“目录型 Skill 包”。

### 2.5 当前 Registry 反而更接近目标形态

有两个非常关键的代码事实：

1. `src/main/registry/serialize.ts` 的 `buildSkillMarkdown()` 已经会输出标准 `SKILL.md`
2. `src/main/registry/exporter.ts` 也已经按 `skill.zip` 这一类标准包格式导出

说明 Registry 层不需要推倒重来，反而能成为新方案的基础。

---

## 三、目标结构

新的 Skill 安装目录统一为：

```text
~/Library/Application Support/one/config/skills/<skill-id>/
  SKILL.md
  references/
  scripts/
  assets/
```

约束如下：

1. `SKILL.md` 是唯一元信息入口
2. 不再存在 `skill.json`
3. 目录名 `<skill-id>` 就是本地 Skill id
4. `references/`、`scripts/`、`assets/` 直接保留，不再做二次投影

### 3.1 为什么目录名仍然建议用 `skill-id`，而不是显示名

虽然用户心智上会说“skillname”，但按代码事实，One 内部有大量地方用 skill id 引用：

- Agent 的 `skillIds`
- Capability 图节点的 `skillIds`
- `load_skill(id)` 工具契约
- Mention 解析命中后落到稳定 id

如果目录名直接等于显示名，那么“重命名 skill”会变成“改目录名 + 批量更新所有引用”。

所以更稳的方案是：

- 目录名 = 稳定 slug / id
- `SKILL.md` frontmatter 中的 `name` = 显示名

这依然是行业里很常见的目录化组织方式，也不违背“标准 Skill 包”的目标。

---

## 四、SKILL.md 规范

建议收敛成下面这套：

```md
---
name: skill display name
description: short summary
tags:
  - writing
  - research
registry_id: optional
registry_version: optional
registry_author: optional
registry_imported_at: optional
---

# Skill Title

...

## Discipline

...
```

### 4.1 规范建议

1. `name`、`description` 放 frontmatter
2. `tags` 作为可选字段正式引入，后续给 RAG 用
3. `discipline` 不再作为持久化独立字段写到别处，统一以 `## Discipline` 为正文标准位置
4. Registry provenance 也放 frontmatter，而不是单独 JSON

### 4.2 兼容读取策略

即使不兼容旧 `*.json`，也仍建议对 `SKILL.md` 内部保持“读宽写严”：

- **读取时**：
  - 允许 frontmatter `discipline`
  - 允许正文 `## Discipline`
- **写回时**：
  - 统一写成 `## Discipline`

这样对外部 Skill 包更友好，也能继续复用当前 `upload.ts` 的一部分解析逻辑。

---

## 五、核心设计变化

### 5.1 Skill 不再是“持久化 JSON 实体”，而是“目录扫描后的运行时投影”

当前 `Skill` 是持久化实体；新方案里它应改成：

- **磁盘事实**：`config/skills/<id>/SKILL.md + 子目录`
- **运行时投影**：主进程扫描目录后解析成 `SkillRecord`

建议把主进程内部拆成两层：

1. `StoredSkill`
   - 从目录直接读出的事实对象
   - 含 `id`、`rootDir`、`skillMdPath`、`scripts[]`
2. `Skill`
   - 对外 IPC / shared 暴露的轻量对象
   - 含 `id`、`name`、`description`、`content`、`discipline`、`hasScripts`

这样可以避免把 `rootDir` 这类纯运行时字段泄露到渲染层。

### 5.2 删除 `scriptPath`，改成 `rootDir + scripts[]`

这是本次改造的关键契约变化。

当前 `scriptPath` 的问题是：

1. 它只是“第一个脚本文件路径”
2. 语义很绕，很多地方还要反推出 `scripts/`
3. 一旦指向错误文件（这次导入就踩过），整个链路都会偏

建议改成：

- 持久化层：不存 `scriptPath`
- 运行时解析后直接得到：
  - `rootDir`
  - `scriptsDir`
  - `scripts[]`

对应改动：

1. `src/main/skills/provider.ts`
   - 删除 `resolveScriptsDir(scriptPath)`
   - 改成 `listSkillScripts(rootDir)`
2. `src/main/tools/builtin/skillScript.ts`
   - 直接从 skill 根目录解析 `scripts/`
3. `src/renderer/src/pages/SkillsPage.tsx`
   - 不再显示 `scriptPath`
   - 改显示“含脚本 / 脚本数量”

### 5.3 FTS/RAG 改成扫描目录

当前 `src/main/storage/skills/fts.ts` 直接扫 `*.json`。

新方案中应改成：

1. 扫 `config/skills/*/SKILL.md`
2. 解析 frontmatter 的 `name/description/tags`
3. 解析正文 `content`
4. 写入 `skills_fts`

这样 `skill_search/load_skill` 工具层可以基本不变，只替换底层数据源。

### 5.4 Skills 管理页改成“编辑 SKILL.md”

当前 SkillsPage 的“编辑”其实是写 JSON 字段。

新方案中需要改成：

1. 打开 skill 时解析 `SKILL.md`
2. 保存时重建 frontmatter + 正文
3. 保留 `references/scripts/assets` 不动

也就是说，前端仍然可以保留现在这套“name/description/content”的表单，但保存目标不再是 JSON，而是 `SKILL.md` 文件。

### 5.5 Registry 导入导出简化

这是目录化方案最直接的收益之一。

当前 exporter/importer 里最绕的部分，是围绕 `scriptPath` 反查上传临时目录。

改成目录化后：

1. **导入**
   - ZIP 解压到 `config/skills/<id>/`
   - 只要目录里有 `SKILL.md`，就是一个有效 skill
2. **导出**
   - 直接把 `config/skills/<id>/` 打成 zip
   - 不需要再“从 JSON + 临时目录重组”

这会显著降低 `registry/importer.ts` 和 `registry/exporter.ts` 的复杂度。

---

## 六、按模块拆解的改造清单

### 6.1 `shared/types.ts`

`Skill` 建议改成：

- 删除：`scriptPath`
- 新增：`hasScripts?: boolean`

是否保留 `createdAt/updatedAt` 有两种方案：

1. **保留**：来自 `SKILL.md` 的 `mtime/birthtime`
2. **删除**：页面不再依赖这两个字段

从当前代码依赖面看，建议**保留**，否则排序和“本地修改”判断会牵连更多地方。

### 6.2 `main/config.ts`

当前 `SkillSchema` 是 JSON 结构校验，后续需要改成：

- 目录扫描后的运行时结构校验
- 不再假设 `scriptPath`

### 6.3 `main/storage/models.ts`

这部分是主改造点。

需要把：

- `JsonCollection<Skill>`
- `countSkills()`
- `getSkill()`
- `listSkills()`
- `saveSkill()`
- `removeSkill()`

整体改成基于目录的实现。

建议新建独立模块而不是继续塞在 `models.ts`：

- `src/main/storage/skills/store.ts`
- `src/main/storage/skills/parser.ts`
- `src/main/storage/skills/markdown.ts`

### 6.4 `main/skills/upload.ts`

建议重构成两层：

1. `parseSkillPackage()`
   - 读 zip 或目录
   - 解析 `SKILL.md`
2. `installSkillPackage()`
   - 解压 / 拷贝到最终目录

顺手把导入入口从“只支持 zip”扩成：

- zip
- 目录

这和用户真实使用场景更匹配。

### 6.5 `main/skills/provider.ts`

改成直接基于 `rootDir`：

- `listSkillScripts(rootDir)`
- `buildSkillXmlBlock()` 仍保留
- `buildDisciplineBlock()` 仍保留

### 6.6 `main/tools/builtin/skillScript.ts`

改成：

1. 取 skill root
2. 找 `<root>/scripts`
3. 校验脚本相对路径
4. `cwd = skill root`

这比当前的 `scriptPath -> scriptsDir -> rootDir` 更直。

### 6.7 `main/storage/skills/fts.ts`

改成扫描目录：

- `countSkillFiles()` → `countSkillDirs()`
- `reindexSkillsFts()` 解析 `SKILL.md`
- `upsertSkillFts()` 改成接收运行时解析结果

### 6.8 `main/ipc/skills.ts`

接口层可以基本保留名字，但语义要变：

- `skills:list`：目录扫描
- `skills:get`：读 `SKILL.md`
- `skills:save`：写 `SKILL.md`
- `skills:pickFile`：支持 zip / directory

### 6.9 `main/registry/importer.ts`

要删掉这条旧逻辑：

- `existing?.scriptPath`
- `getSkillUploadTempDir()`
- `uploadSkillFile(zipPath)` 再转 JSON

新逻辑应变成：

- `download skill.zip`
- 解压为标准目录
- 写入目标 skill 目录
- 从 `SKILL.md` 再次解析得到运行时对象

### 6.10 `main/registry/exporter.ts`

`buildSkillZip()` 直接打目录，不再重组：

- 目录内已有 `SKILL.md`
- `scripts/references/assets` 原样 zip

### 6.11 `renderer/pages/SkillsPage.tsx`

需要同步做 3 个调整：

1. 删除 `scriptPath` 展示
2. 改成 `hasScripts`
3. 保存逻辑改成写 `SKILL.md`

### 6.12 `renderer/pages/ListPage.tsx`

这里也有 skill 编辑入口，不能漏。

---

## 七、实施阶段

### Phase 1：底层目录化存储落地

目标：

- Skill 主存储改成目录扫描
- `listSkills/getSkill/saveSkill/removeSkill` 全部可用
- SkillsPage 可以正常展示和编辑

完成标志：

- 删除 `src/main/storage/models.ts` 中 skill 的 `JsonCollection` 依赖
- 目录内只有 `SKILL.md` 也能完整显示 skill

### Phase 2：脚本与 RAG 链路改造

目标：

- 删除 `scriptPath`
- `skill_run_script` 改走 skill 根目录
- `skill_search/load_skill` 改扫目录化 skill

完成标志：

- `provider.ts` / `skillScript.ts` / `fts.ts` 不再引用 `scriptPath`

### Phase 3：Registry 与导入导出改造

目标：

- import/export 直接面对标准 Skill 包
- 删除 `getSkillUploadTempDir` 和“临时目录反查”思路

完成标志：

- 导入 zip 后本地目录就是最终目录
- 导出 zip 直接打当前本地 skill 目录

### Phase 4：UI/契约收尾

目标：

- 渲染层不再出现 `scriptPath`
- `Skill` shared 类型收敛到新结构
- 文档和测试更新

---

## 八、风险点

### 8.1 “不要 `skill.json`”会让一些元信息只能来自文件系统或 frontmatter

这不是问题，但必须明确口径：

- `registry` provenance 放 frontmatter
- `updatedAt` 用 `SKILL.md` mtime
- `hasScripts` 用目录扫描得出

不能再假设有一个额外 JSON 能兜底。

### 8.2 skill 重命名策略必须先定

如果目录名就是 skill id，那么：

- 改显示名只改 `SKILL.md`
- 不改目录名

这是推荐方案。

如果目录名强绑定显示名，后续所有引用更新都会更麻烦。

### 8.3 这是“非兼容改造”，要明确清空旧世界

既然本轮明确“不兼容旧的”，那就不要再维持双格式：

- 不要同时扫 `*.json` 和目录
- 不要保留 `scriptPath`
- 不要在新逻辑里再绕回 JSON

否则复杂度会一直留着。

---

## 九、最终建议

基于当前代码事实，我建议 One 直接把 Skill 存储目标定成：

```text
config/skills/<skill-id>/
  SKILL.md
  references/
  scripts/
  assets/
```

同时明确这 4 条原则：

1. `SKILL.md` 是唯一事实源
2. 目录名就是本地 skill id
3. `scriptPath` 从系统里彻底删除
4. Registry / 导入 / 本地安装 / RAG 全部统一到同一种目录格式

这是一次**中等偏大的结构改造**，但方向正确，而且能同时解决：

- 外部 skill 生态对接不顺
- 本地目录难以理解
- registry 导入导出链路绕
- scriptPath 语义别扭

从收益看，是值得单独开一个完整重构任务来做的。
