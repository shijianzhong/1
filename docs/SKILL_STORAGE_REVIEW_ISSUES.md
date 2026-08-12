# Skill 目录化改造 — Review 遗留问题清单

> 日期：2026-08-11
>
> 范围：针对 Skill 存储目录化 + `scriptPath` 链路清除 + Skill RAG 工具这轮改动
> （对应 `docs/SKILL_STORAGE_STANDARD_PLAN.md`）的代码 review。
>
> P0（缓存竞态，上传含脚本技能后 `hasScripts` 徽章可能不出现）已修复，
> 见 `store.ts` 导出的 `invalidateSkillsCache()` + `ipc/skills.ts` / `registry/importer.ts`
> extract 后调用。
>
> 决策记录：**主 agent 用 RAG 方案接入 skill** 是有意决策，保持现状。
> persona 绑定 skill 在 home 改走 RAG、编排节点仍走 inline 的语义分歧由此决策派生，
> 不再作为缺陷列出，仅在本文件末尾「决策与后续」记一笔。

---

## 修复状态总览（2026-08-11 全部修复）

| 编号 | 问题 | 状态 |
|------|------|------|
| P1 | `skillScript.ts` i18n 不一致 | ✅ 已修复 |
| P2 | `description` fallback 不一致 | ✅ 已修复 |
| P2 | `skills:pickFile` 失败时 SKILL.md 残留 | ✅ 已修复 |
| P2 | `countSkills()` 不校验 `SKILL.md` | ✅ 已修复 |
| P3 | `store.ts` `Date.now()` 兜底 | ✅ 已修复 |
| P3 | `yamlSafe` re-export | ✅ 确认保留（serialize.test.ts 仍依赖） |
| P3 | `docs/` 与 `scripts/` 未入库 | ✅ 已入库 |

---

## P1 — `skillScript.ts` i18n 统一 ✅

**位置**：`src/main/tools/builtin/skillScript.ts`

**修复**：所有错误返回统一携带 `messageKey`，与 `skillRag.ts` 口径一致。渲染层根据 key 翻译，`hint` 字段保留动态上下文（技能名 / 可用脚本清单）。

新增 i18n key（`zh-CN/errors.json` + `en/errors.json`）：
- `errors.tools.skill_not_found`
- `errors.tools.skill_no_scripts`
- `errors.tools.skill_no_scripts_dir`
- `errors.tools.skill_invalid_path`
- `errors.tools.skill_script_not_found`
- `errors.tools.skill_unsupported_type`
- `errors.tools.skill_script_timeout`
- `errors.tools.skill_stdout_limit`
- `errors.tools.skill_interpreter_not_found`

---

## P2 — `description` fallback 统一 ✅

**位置**：`src/main/skills/upload.ts`（`parseSkillZip`）

**修复**：移除 `fallbackDescription()` 函数，`description` 缺失时返回 `undefined`，与 `parser.ts` 的 `parseSkillMd` 行为一致。description 是 frontmatter 显式字段，不从 content 造片段。

---

## P2 — `skills:pickFile` 失败回滚 ✅

**位置**：`src/main/ipc/skills.ts`

**修复**：`extractSkillResourcesToDir` 调用包裹 try/catch，失败时执行 `removeSkill(saved.id)` 回滚，避免残缺 skill（有 SKILL.md 无脚本/资源）残留。随后 `invalidateSkillsCache()` 确保缓存一致。

---

## P2 — `countSkills()` 校验 SKILL.md ✅

**位置**：`src/main/storage/skills/store.ts`

**修复**：`countSkills()` 改为 `getCachedSkills().length`，复用缓存（与 `listSkills` 同源），仅计数含 `SKILL.md` 的有效 skill 目录，与 `countSkillFiles()` 口径一致。

---

## P3 — 小问题 ✅

### `yamlSafe` re-export 保留

**位置**：`src/main/registry/serialize.ts:13`

确认 `serialize.test.ts` 仍从 `./serialize` 导入 `yamlSafe`，re-export 保留（review 文档原文：「留着也无害」）。

### `store.ts` `Date.now()` 兜底改为 `0`

**位置**：`src/main/storage/skills/store.ts:54`

stat 失败时 `mtimeMs` / `birthtimeMs` 从 `Date.now()` 改为 `0`，避免引入虚假时间戳。

### `docs/` 与 `scripts/` 已入库

`docs/SKILL_RAG_EVAL.md`、`docs/SKILL_RAG_PLAN.md`、`docs/SKILL_STORAGE_STANDARD_PLAN.md`、`scripts/skill-rag-eval.mjs` 均已 git tracked。

---

## 决策与后续

### 已定：主 agent 用 RAG 接入 skill

home 主助手不再 inline 注入 `persona.skillIds`，改由 `buildSkillInstruction` 引导 LLM 用 `skill_search` / `load_skill` 自主检索。@提及的 skill 仍走 inline（显式意图）。这是有意决策。

派生的语义分歧（同一项目里「绑定的 skill」在 home 是 RAG、在编排节点 `orchestrate.ts:122-138` 仍走 inline）由此决策派生，**不作为缺陷**。后续若要让编排节点也统一切 RAG，需单开任务，并同步更新：
- `CLAUDE.md` 铁律22 描述（persona 绑定 skill 注入 → RAG 检索）
- `task.md` 记一笔
- 编排路径 `skillIds` → SkillContextProvider 链路移除或保留为「节点级显式绑定」特例
