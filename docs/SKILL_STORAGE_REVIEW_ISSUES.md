# Skill 目录化改造 — Review 遗留问题清单

> 日期：2026-08-11
>
> 范围：针对 Skill 存储目录化 + `scriptPath` 链路清除 + Skill RAG 工具这轮改动
> （对应 `docs/SKILL_STORAGE_STANDARD_PLAN.md`）的代码 review。
>
> P0（缓存竞态，上传含脚本技能后 `hasScripts` 徽章可能不出现）已修复，
> 见 `store.ts` 导出的 `invalidateSkillsCache()` + `ipc/skills.ts` / `registry/importer.ts`
> extract 后调用。本文档只列**仍未修**的问题，按严重度排序。
>
> 决策记录：**主 agent 用 RAG 方案接入 skill** 是有意决策，保持现状。
> persona 绑定 skill 在 home 改走 RAG、编排节点仍走 inline 的语义分歧由此决策派生，
> 不再作为缺陷列出，仅在本文件末尾「决策与后续」记一笔。

---

## P1 — `skill_not_found` 错误的 i18n 处理两处不一致

**位置**
- `src/main/tools/builtin/skillRag.ts:34` — 返回 `messageKey: 'errors.tools.skill_not_found'`（走 i18n）
- `src/main/tools/builtin/skillScript.ts` — 同名 `skill_not_found` 错误返回 `hint` 中文字符串 `技能「${skillRef}」不存在`（不走 i18n，硬编码中文）

**问题**
同类错误两种呈现：`skillRag.ts` 经 i18n key 由渲染层翻译；`skillScript.ts` 直接塞中文进 hint。后者违反 T2「主进程不硬编码中文报错」，卡在「i18n 尾巴」缺口上。

**建议**
统一两处：都带 `messageKey`（`errors.tools.skill_not_found` 已在 `en/errors.json` / `zh-CN/errors.json` 补齐），渲染层翻译。或若 hint 里的动态上下文（技能名/可用脚本清单）需要保留，可同时带 `messageKey` + `hint`——key 决定翻译基线，hint 补动态信息。

---

## P2 — `description` fallback 在 zip 导入与目录扫描两条路径不一致

**位置**
- `src/main/skills/upload.ts:118`（`parseSkillZip`）— `fm.description` 缺失时调 `fallbackDescription(body)` 取正文前 120 字
- `src/main/storage/skills/parser.ts:130`（`parseSkillMd`，目录扫描）— 不做 fallback，description 留 undefined

**问题**
同一个 SKILL.md：走 zip 导入保存后 description 有值（正文片段，被 `buildSkillMd` 写进 frontmatter 固化）；走目录直接扫描（重启后 `listSkills` / 管理页编辑）description 是 undefined。纯手动在管理页新建、只填 content 没填 description 的 skill，description 一直 undefined；而 zip 导入的同形态 skill 却有 fallback 值。行为不统一。

**建议**
两边都不 fallback（description 缺就缺，别从 content 造），或两边都 fallback。倾向不 fallback——description 是 frontmatter 显式字段，从 content 造一个片段容易误导（正文首句未必是摘要）。

---

## P2 — `skills:pickFile` 失败时 SKILL.md 残留

**位置**：`src/main/ipc/skills.ts:30-40`

**问题**
时序：`saveSkill` 先 mkdir + 写 `SKILL.md`（skill 已落盘并在列表里）→ `extractSkillResourcesToDir` 若抛异常（磁盘满 / 路径异常 / zip 损坏），IPC 返回 `ok:false`，但 SKILL.md 已存在、skill 已可见。用户会看到一个"无脚本/无资源"的残缺 skill。下次重传同 id 会覆盖，可恢复，非数据损坏。

**建议**
更稳的顺序：先 extract 到临时位置 → `saveSkill`（写 SKILL.md）→ 移入最终目录；或 extract 失败时回滚 `removeSkill(saved.id)`。优先级不高（可恢复），列为收尾项。

---

## P2 — `countSkills()` 不校验 `SKILL.md`，与 `countSkillFiles()` 口径不同

**位置**
- `src/main/storage/skills/store.ts:107-113`（`countSkills`）— 数所有子目录（仅跳过 `skl_upload_`），**不校验 `SKILL.md` 存在**
- `src/main/storage/skills/fts.ts:33-40`（`countSkillFiles`）— 校验 `SKILL.md` 存在
- `src/main/orchestrator/home.ts:315`（`buildSkillInstruction(countSkills())`）— 用的是不校验 SKILL.md 的 `countSkills`

**问题**
`db.ts` 启动自检用 `countSkillFiles`（FTS 一致），但 `buildSkillInstruction` 给 LLM 的技能数用的是 `countSkills()`（不校验）。若磁盘有空目录（导入失败残留 / 用户手动建了空目录），`countSkills` 多算，`buildSkillInstruction` 给 LLM 的技能数偏大，与 RAG 实际可检索数对不上。

**建议**
`countSkills` 也校验 `SKILL.md` 存在，与 `countSkillFiles` 合一（甚至直接删掉 `countSkillFiles`，`db.ts` 改调 `countSkills`）。

---

## P3 — 小问题

### `serialize.ts` 的 `yamlSafe` re-export 可清理

**位置**：`src/main/registry/serialize.ts:10`

注释说「backward compat」，re-export `yamlSafe` from parser。确认无其他模块直接 `import { yamlSafe } from './serialize'` 后可删；留着也无害。`buildSkillMarkdown` 的 re-export 同理（`exporter.ts` 仍用它，保留）。

### `store.ts:54` 用 `Date.now()` 兜底 stat 失败

**位置**：`src/main/storage/skills/store.ts:54`

stat 失败时 `createdAt/birthtimeMs` 用 `Date.now()` 冒充，会让 `createdAt` 引入虚假时间。stat 失败极罕见，可接受，但更稳妥用 `0` 或 `mtimeMs`，至少不造一个"当前时间"当 birthtime。

### `docs/` 与 `scripts/` 未入库

`docs/SKILL_RAG_EVAL.md`、`docs/SKILL_RAG_PLAN.md`、`docs/SKILL_STORAGE_STANDARD_PLAN.md`、`scripts/skill-rag-eval.mjs` 均为 untracked。确认是否随本轮改动 `git add` 入库。`SKILL_STORAGE_STANDARD_PLAN.md` 是本轮改造的设计依据，建议入库；`SKILL_RAG_*` 与 RAG 工具配套，建议入库；`scripts/skill-rag-eval.mjs` 看是否作为长期评测脚本保留。

---

## 决策与后续

### 已定：主 agent 用 RAG 接入 skill

home 主助手不再 inline 注入 `persona.skillIds`，改由 `buildSkillInstruction` 引导 LLM 用 `skill_search` / `load_skill` 自主检索。@提及的 skill 仍走 inline（显式意图）。这是有意决策。

派生的语义分歧（同一项目里「绑定的 skill」在 home 是 RAG、在编排节点 `orchestrate.ts:122-138` 仍走 inline）由此决策派生，**不作为缺陷**。后续若要让编排节点也统一切 RAG，需单开任务，并同步更新：
- `CLAUDE.md` 铁律22 描述（persona 绑定 skill 注入 → RAG 检索）
- `task.md` 记一笔
- 编排路径 `skillIds` → SkillContextProvider 链路移除或保留为「节点级显式绑定」特例

### 待修优先级

1. P1 i18n `skill_not_found` 统一（顺手补 `skillScript.ts` 的 messageKey，清 i18n 尾巴）
2. P2 `description` fallback 统一（倾向都不 fallback）
3. P2 `countSkills` 校验 SKILL.md（与 FTS 口径合一）
4. P2 pickFile 失败回滚（可恢复，优先级最低）
5. P3 小问题（yamlSafe re-export / Date.now 兜底 / docs 入库）
