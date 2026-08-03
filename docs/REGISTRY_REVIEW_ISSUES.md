# Registry 代码审查问题清单

> 审查范围：`src/main/registry/`（exporter / serialize / publisher / importer / service / client / sources / remap）、`src/main/skills/provider.ts`、`src/main/tools/builtin/skillScript.ts`、渲染层 Registry 页面
> 审查时间：2026-08-03
> 设计文档：`docs/REGISTRY_PLAN.md`
> 编译状态：通过 ｜ 测试状态：provider 12 用例 + skillScript 7 用例全绿

> **2026-08-03 二轮核验与修复**：全部 9 条 + 权衡/通过项经代码事实核验——6 条成立已修 ✅（P1#1 spread、P1#2 错误码、P2#4 YAML、P2#5 去重、P2#6 秒级、**P3#8 slug 分配**——当晚用户实撞由「不修」升级必修，见该节）；2 条成立但维持现状 ⚪（P2#7 事务性、P3#9 forks 展示，理由见各节）；P1#3 定性修正（非缺陷，改判设计外增强）；权衡#3（writeJsonFile 同步）删除、一处「通过项」（错误分类 i18n）移出——两处初审言过其实。修复后 typecheck + 265 测试全绿。

---

## 严重程度说明

- **P0（严重）**：影响功能正确性，用户可感知的缺陷
- **P1（中等）**：不影响主流程，但存在隐患或维护风险
- **P2（轻微）**：代码整洁度、边界场景、体验优化

---

## P1：Provenance 回写手动列举字段，类型扩展时易静默丢数据 ✅ 已修

> **二轮核验补充**：此条比初审更严重——不仅是未来风险，还有**现存丢字段**：`Agent.source` 未在枚举内且 `saveAgent` 为 `source: parsed.source ?? 'custom'`（不回退 existing），导出内置 agent 会把 `source: 'builtin'` 洗成 `'custom'`（AgentsPage「自定义」徽标误显）。另初审引用代码漏了 `modelId`（实际 exporter.ts:235 有），不影响结论。

### 位置

`src/main/registry/exporter.ts` — `applyExport` 中 Skill（~201-212 行）、Agent（~228-242 行）、Capability（~260-269 行）

### 现状

回写 provenance 时手动列举了实体的所有字段传给 `saveSkill`/`saveAgent`/`saveCapability`：

```typescript
saveAgent({
  id: agent.id,
  name: agent.name,
  description: agent.description,
  instructions: agent.instructions,
  skillIds: agent.skillIds,
  temperature: agent.temperature,
  maxTokens: agent.maxTokens,
  outputConstraints: agent.outputConstraints,
  registry: { registryId: item.slug, version: item.version, importedAt: now },
}, { now })
```

### 影响

当 `Agent`/`Skill`/`Capability` 类型未来新增字段时，这里的手动列举不会自动包含新字段，导致导出后回写的实体丢失新增字段的数据——且不会报错（Zod schema 通常对新字段设 optional）。

### 建议修法

改为 spread 原对象 + 覆盖 registry 的模式：

```typescript
saveAgent({
  ...agent,
  registry: { registryId: item.slug, version: item.version, importedAt: now },
}, { now })
```

Skill 和 Capability 同理。需确认 `saveAgent` 的 input schema 接受完整实体对象（当前经 `AgentInputSchema.parse`，spread 后多余字段会被 Zod strip 掉，安全）。

**✅ 已修（2026-08-03）**：三处 save* 均改 spread 模式（`{...entity, registry}`），`source` 字段恢复保留（`AgentInputSchema` 含 `source` 枚举，`config.ts:65`）；`createdAt/updatedAt` 由 save 内部按 `existing` 处理不受影响。

---

## P1：`waitForkReady` 不区分错误码，401/403 也轮询 40 秒 ✅ 已修

> **二轮核验补充**：成立但场景比初审描述的窄——fork 创建 POST 在轮询**之前**，401/403 大多在创建时就抛出映射；轮询期遇 4xx 主要是限流或 token 中途失效。另初审修法「4xx 全抛」有误：**404 是建仓窗口期的预期状态**，全抛会把正常轮询打死，实现已排除 404。

### 位置

`src/main/registry/publisher.ts` — `waitForkReady`（~69-78 行）

### 现状

```typescript
for (let i = 0; i < 20; i++) {
  try {
    const res = await gh('GET', `/repos/${forkFullName}`)
    if (res) return
  } catch {
    // 所有错误一律等 2s 重试
  }
  await sleep(2000)
}
throw new Error('fork 等待超时')
```

### 影响

如果 fork 创建后因 Token 权限不足（403）或 Token 无效（401）导致轮询始终失败，用户需等待 ~40 秒才能看到错误——且最终错误信息是「等待超时」，丢失了实际原因。

### 建议修法

区分 4xx 错误立即抛出，仅对网络错误/5xx 重试：

```typescript
let lastError: unknown
for (let i = 0; i < 20; i++) {
  try {
    const res = await gh('GET', `/repos/${forkFullName}`)
    if (res) return
  } catch (e) {
    lastError = e
    if (e instanceof GhError && e.status >= 400 && e.status < 500) throw e
  }
  await sleep(2000)
}
throw new Error(`fork 等待超时（最后错误：${String(lastError)}）`)
```

**✅ 已修（2026-08-03）**：401/403/429 立即抛（经 `toGhMessage` 映射为分场景中文引导）；404（建仓窗口期）与网络/5xx 继续轮询；超时错误附最后错误摘要，不再丢失真因。

---

## ~~P1：批量更新全部功能缺失~~ 定性修正：非缺陷，设计外增强建议

> **二轮核验修正（2026-08-03）**：初审引用的设计依据不成立。设计文档 §3.4 原文为「**一键更新 = 按 §3.2 重导入并保留本地 id 覆盖**」——定义的就是**单项**重导入；Phase 5 条目「一键更新已导入资产」同样无批量要求。现有逐项快捷更新（无脚本直接 apply、含脚本回落详情抽屉确认）**已完整实现设计定义**，本条不构成「功能缺失」。
>
> 批量更新是合理的**设计外增强**，降级为 backlog 可选需求（P3），不在本期修复范围。若未来实现，注意含脚本资产必须保留逐项确认（脚本内容可能随版本变化，不能批量盲信）。

### 位置

渲染层 `RegistryPage.tsx`

### 设计文档原文（§3.4 / Phase 5）

- 「一键更新 = 按 §3.2 重导入并保留本地 id 覆盖」（§3.4）
- 「一键更新已导入资产」（Phase 5 体验优化条目）

### 当前实现（符合设计）

「有更新」徽标旁快捷按钮 → plan 无脚本直接 apply；含脚本回落详情抽屉让用户确认脚本清单；结果状态条反馈。

---

## P2：`buildSkillMarkdown` frontmatter 未转义 YAML 特殊字符 ✅ 已修

> **二轮核验补充**：成立。补充事实：自家 `parseFrontmatter` 按首个冒号切分、已支持去引号，所以带冒号的名字在**自家回环**下不出错；风险在第三方真 YAML 解析器（`name: Code: Reviewer` 直接抛错、` #` 被当注释截断）。修复需双侧配套：导出侧转义 + 导入侧双引号反转义，否则回环会残留 `\` 转义符。

### 位置

`src/main/registry/serialize.ts` — `buildSkillMarkdown`（~78-80 行）

### 现状

```typescript
const fm: string[] = ['---', `name: ${skill.name}`]
if (skill.description) fm.push(`description: ${skill.description}`)
```

### 影响

如果 `skill.name` 或 `skill.description` 包含 YAML 特殊字符（`:`、`#`、`"`、`\n`、`[`、`{` 等），生成的 frontmatter 会被错误解析。例如 `name: Code: Reviewer` 会导致 YAML 解析器把值截断为 `Code`。

### 建议修法

对含特殊字符的值加双引号包裹：

```typescript
const yamlSafe = (s: string) =>
  /[:#\n"'[\]{}]/.test(s) ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : s

const fm: string[] = ['---', `name: ${yamlSafe(skill.name)}`]
if (skill.description) fm.push(`description: ${yamlSafe(skill.description)}`)
```

**✅ 已修（2026-08-03）**：`serialize.ts` 新增导出 `yamlSafe()`（按初审建议形式），`buildSkillMarkdown` 的 name/description 走转义；`upload.ts parseFrontmatter` 双引号值配套反转义（`\"`→`"`、`\\`→`\`），导出→导入回环保真。serialize.test.ts +2 例（yamlSafe 6 断言 / buildSkillMarkdown 转义），upload.test.ts +2 例（回环 + 无引号注释截断行为不变）。

---

## P2：`droppedSkillIds` / `droppedAgentIds` 含重复项 ✅ 已修

### 位置

`src/main/registry/serialize.ts` — `serializeCapabilityManifest`（~117-154 行）

### 现状

多个图节点引用同一个未映射 skill/agent 时，`droppedSkillIds`/`droppedAgentIds` 数组会包含重复的 localId。

### 影响

不影响功能正确性（仅用于日志），但日志输出不够干净。

### 建议修法

返回前去重：

```typescript
droppedSkillIds: [...new Set(droppedSkillIds)],
droppedAgentIds: [...new Set(droppedAgentIds)],
```

**✅ 已修（2026-08-03）**：按建议去重（`serialize.ts:183-187`），serialize.test.ts +1 例（两节点引用同一未映射 skill/agent → dropped 各 1 项）。

---

## P2：自动 PR 分支名精度不足，同分钟重复发布会 422 ✅ 已修

### 位置

`src/main/registry/publisher.ts` — `submitExportAsPr`（~128-136 行）

### 现状

```typescript
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12) // YYYYMMDDHHmm
const branch = `publish/${primary.slug}-${stamp}`
```

### 影响

同一分钟内对同一 slug 发起两次发布会生成相同分支名。第二次 `POST /git/refs` 因 refs 已存在返回 422，用户看到不友好的错误。

### 建议修法

增加秒级精度或短随机后缀：

```typescript
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) // YYYYMMDDHHmmss
```

或在 422 catch 中追加随机后缀重试一次。

**✅ 已修（2026-08-03）**：采用秒级精度方案（`slice(0, 14)`，`publisher.ts`）。补充核验事实：初审判断准确——PR 侧的 422 复用回退**不覆盖** refs 创建侧的 422，同分钟重发确实会暴露 `Reference already exists` 给用户。

---

## P2：Contents API 逐文件提交无事务性 ⚪ 确认成立，维持现状

### 位置

`src/main/registry/publisher.ts` — `submitExportAsPr`（~139-159 行）

### 现状

逐文件调用 Contents API `PUT /repos/{repo}/contents/{path}` 提交。如果第 N 个文件失败，前 N-1 个文件已提交到分支，分支处于不完整状态。

### 影响

Fork 内会残留不完整分支。虽然不影响上游仓库（未合并），但用户重试时会创建新分支，旧分支成为垃圾引用。

### 建议修法

短期可接受（用户可手动删除 fork 上的脏分支）。长期可考虑 Git Trees API 批量提交（单次 atomic commit 包含所有文件）。至少在日志中记录已提交文件数以便排查。

**⚪ 二轮核验结论（2026-08-03）**：成立，维持现状。补充事实：半成品分支在 **fork** 上（非上游 Registry 主仓），用户重试会走秒级新分支 + PR 422 复用回退，无实际危害；导出失败时 UI 有明确错误提示。

---

## P3→P0：slug 兜底 `Date.now().toString(36)` 并发时可能重复 ✅ 已修（升级必修，用户实撞）

### 位置

`src/main/registry/exporter.ts` — `planItemFor`（~49 行）

### 现状

```typescript
const slug = provenance?.registryId ?? (slugify(name) || `${kind}-${Date.now().toString(36)}`)
```

### 影响

如果两个资产同时 plan 且名称均为纯特殊字符（slugify 返回空串），它们可能获得相同的 `kind-timestamp` 兜底 slug。

### 建议修法

追加短随机串：

```typescript
`${kind}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
```

**✅ 已修（2026-08-03 当晚，用户首用实撞后升级必修）**：

- **概率误判更正**：不是「并发 plan 才可能撞」——同一次 planExport 的循环里多个同类型中文名资产在**同一毫秒**调 `Date.now()`，兜底 slug **必然全撞**（用户导出 4 个中文名 agent 全员 `agent-msd1ciya`）。「用户弹窗改 slug 兜底」也过于乐观——默认 slug 全撞意味着要逐一手改，体验即坏。
- **修法（exporter.ts `allocSlug`）**：兜底链改为 `slugify(name)` → `slugify(本地 id 去类型前缀)`（`agt_content_review` → `content-review`，中文名也有语义 slug）→ `kind-时间戳-4位随机hex`；冲突避让先补 `-kind` 后缀（`wechat-writing-agent`）再退 `-2/-3` 序号；`taken` 集合跨类型（对齐 CI 全局唯一规则）。
- **两阶段分配**：provenance slug 是固定身份，先全部占位再分配 fallback——与图遍历顺序无关，防「agent 先抢 clean slug、provenance 后撞车」的顺序依赖。
- **测试**：exporter.test.ts +3 例（用户实撞场景 9 资产唯一且语义化 / 双中文名随机后缀互异 / provenance 占位避让）。265 全绿。

---

## P3：`getRepoStats` 返回 `forks` 但渲染层未使用 ⚪ 确认成立，未修

### 位置

`src/main/registry/publisher.ts` — `getRepoStats`（~229 行）+ `RegistryPage.tsx`（~238-241 行）

### 现状

`getRepoStats` 返回 `{ stars, forks }`，但 RegistryPage 只展示了 stars Badge，forks 数据未使用。

### 建议修法

考虑也展示 forks 数量，或从返回类型中移除未使用字段。

**⚪ 二轮核验结论（2026-08-03）**：成立，琐碎。本期未修——等 Registry 页头部视觉再打磨时一并处理（展示或删字段二选一）。

---

## 审查通过项（无问题）

| 模块 | 审查结论 |
|------|----------|
| **Skill ContextProvider 三注入点** | beforeRun / afterRun / async spawn 全部正确实现，铁律 22/23 完全合规 |
| **Discipline 提取** | frontmatter 优先 → `## Discipline` 段落回退，逻辑正确 |
| **三处调用点统一** | 编辑器编排 / 首页主 Agent / 首页组队节点均使用 `SkillContextProvider.beforeRun`，格式一致 |
| **Token 存储** | safeStorage 加密，不明文落盘，不进入渲染进程，铁律 3 合规 |
| **Token 域名白名单** | `shouldAttachToken()` 只对 `github.com` / `*.githubusercontent.com` 附带 Authorization，自定义镜像不会收到用户 token |
| **多源 fallback** | GitHub raw + jsDelivr + 磁盘缓存兜底，8s 超时 + 限流检测（403 → `registry_rate_limited`） |
| **Slug 路径穿越防护** | `/^[a-z0-9][a-z0-9-]{0,63}$/` 严格正则 |
| **渲染层零直连** | 所有网络请求经主进程 IPC，铁律 2 合规 |
| **脚本执行安全** | 拒绝绝对路径 + `..` 穿越 + resolve 校验 + 解释器白名单 + 60s 超时 + 256KB stdout 上限 + AbortSignal 联动 |
| **Importer 级联逻辑** | Skill/Agent/Capability 三级级联正确，依赖缺失不阻断（warn + 剔除降级） |
| **Importer 本地修改冲突** | `isLocallyModified()` 检测 `updatedAt > importedAt`，跳过覆盖防丢用户编辑 |
| **Remap 纯函数** | slug → 本地 id 映射、modelId 防御性剥离、空数组字段删除（与「未配置」同语义），逻辑正确 |
| **自动 PR 422 复用** | 同分支已有 open PR 时查找并复用，不重复创建 |
| ~~**错误分类**~~（**二轮核验：移出通过项**） | `toGhMessage` 401/403/404/网络的分场景映射**逻辑**好，但产出是主进程**硬编码中文字符串**（非「i18n 友好错误码」），违反铁律 T2「主进程不硬编码中文报错」——属 task.md 已知缺口「errors.\* 主进程结构化错误 key 未齐」的一部分，待该缺口统一收口 |
| **测试覆盖** | provider 12 用例 + skillScript 7 用例，覆盖正常路径 + 边界 + 安全场景 |

---

## 已知设计权衡（非 bug）

| 项目 | 说明 |
|------|------|
| **Discipline 重复注入** | discipline 内容在 `<skill>` XML 块（content）和 `【输出纪律】` 段中各出现一次。`extractDisciplineSection` 不从 content 中剥离 discipline 段落——7.4 落地前 content 是唯一注入载体，剥离会让纪律段从 prompt 消失。后续可从 content 中剥离已提取的 discipline 段以节省 token |
| **脚本无沙箱** | 脚本以用户身份直接运行在宿主机上，无环境变量隔离、无文件系统沙箱。桌面应用的合理取舍（类似 VS Code 信任工作区），依赖信任链设计配合 |
| ~~**`writeJsonFile` 同步 I/O**~~（**二轮核验：删除此条**） | 「与项目 async 约定不一致」不成立——`json-store` 全项目一致同步（`writeFileSync` + tmp+rename 原子写），task.md 误报排除清单早已正名「原子写策略有意为之」；config 规模下同步是正确的简化，不存在被违反的 async 约定，也不存在「应增加 async 版本」的长期债务 |

---

## 修复优先级建议 → 执行结果（2026-08-03 收口）

| 原计划 | 执行结果 |
|--------|----------|
| 1. 先修 P1 | ✅ spread 回写（顺带修复 `source` 丢失 live bug）+ `waitForkReady` 401/403/429 即抛（404 建仓窗口期除外）；「批量更新」经核验为定性错误，已改写为 backlog 增强建议 |
| 2. 再修 P2 | ✅ YAML 转义（导出 `yamlSafe` + 导入反转义配套）✅ dropped 去重 ✅ 分支名秒级精度；Contents API 事务性确认维持现状（fork 侧半成品分支无危害，重试覆盖） |
| 3. P3 收尾 | ✅ slug 分配当晚升级必修（用户实撞，见 P3#8 节）；⚪ forks 字段等视觉打磨一并处理 |

修复后 `npx tsc --noEmit` 通过、`npx vitest run` 265 例全绿（serialize +3、upload +2、exporter +3）。
