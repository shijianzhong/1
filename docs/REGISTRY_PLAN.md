# GitHub Registry 共享方案

> 2026-08-02 可行性修订版：对照代码实证修正了存储层认知、图节点引用模型、身份映射、
> modelId 可移植性、国内可达性、index.json 冲突、Token 权限表述等问题。
> 动工前必读 §0（设计基线）与 §2（身份映射）——这两节是原方案缺失的 P0 设计。

## 概述

以 GitHub 公开仓库作为共享注册中心（Registry），用户可将 app 内创建的角色（Agent）、技能（Skill）、能力（Capability）发布到 Registry，其他用户无需 GitHub Token 即可浏览和导入。

**仓库地址**：`https://github.com/shijianzhong/one-registry`

---

## 0. 与现有架构对齐的设计基线

以下均为代码实证事实，本方案所有设计以此为准（勿凭直觉假设）：

1. **配置类资产存 JSON 文件，不在 SQLite**。agents/skills/capabilities 走 `JsonCollection`（`userData/config/{agents,skills,capabilities}/{id}.json`，`src/main/storage/models.ts`）；SQLite 只存 sessions/messages/tasks/memory。导入 = 调 `saveAgent/saveSkill/saveCapability`，不传 id 即自动生成 `agt_`/`skl_`/`cap_` 前缀新 id——天然避免与本地已有 id 冲突。
2. **编排图节点内联 Agent 配置快照，运行时不查角色库**（`builder.ts` BuildDeps 注释 + `home.ts agentNodeFromAgent`）。节点 data 内含 `label/instructions/description/skillIds/modelId/temperature/maxTokens/outputConstraints/sourceAgentId`。推论：**Capability 导出天然自包含**，运行时真正依赖的只有 skill（`orchestrate.ts` 按 `data.skillIds` → `getSkill()` 解析，缺失仅 warn 降级）。
3. **`skillIds` 是本地实体 id**（`skl_xxx`），跨机器无意义——导入必须重映射，导出必须转 registry slug（§2）。
4. **`Agent.modelId` 是本地 ModelConfig 的 id**（`mdl_xxx`），且模型经 provider 体系解析（baseUrl/key 在 provider 级）——**不可移植**，导入必须回退（§3.2）。
5. **Skill zip 导入链路可直接复用**：`skills/upload.ts` 的 `parseSkillZip`/`uploadSkillFile` 接受文件路径，下载到临时目录即可喂入；已有 10MB / 200 文件 / 路径穿越防护。注意既有 quirk：resources/scripts 解压目录按**上传临时 id**（`skl_upload_xxx`）命名而非最终 skill id，导出重组 zip 时按 `scriptPath` 反查目录，**不假设目录名 == skill id**。
6. **Skill 实体有 `discipline`（输出纪律段）与 `scriptPath` 字段**，manifest 必须覆盖；`Skill` 不持久化 resources 列表（资源只落磁盘）。
7. **主进程网络请求模式现成**：`tools/builtin/web.ts` 的纯 fetch + AbortController 超时模式可抄；渲染层零直连，一切经 preload 白名单 + `withHandler` 结构化错误（铁律 2）。
8. **Token 存储复用 vault**：`secrets/vault.ts` 基于 safeStorage，`setKey`/`getKey` 现成（铁律 3）。

---

## 1. Registry 仓库结构

```
one-registry/
├── README.md                  # 使用说明 + 贡献指南 + 审核标准
├── index.json                 # 全局索引（CI 自动生成，贡献者勿手改，见 §6）
├── scripts/
│   └── build-index.mjs        # 扫描 manifest → 重建 index.json
├── .github/workflows/
│   ├── validate.yml           # PR 校验：manifest schema / 目录名==id / zip 存在性
│   └── reindex.yml            # merge 到 main 后自动重建 index.json
├── agents/
│   └── {agent-id}/
│       └── manifest.json      # 角色定义
├── skills/
│   └── {skill-id}/
│       ├── manifest.json      # 技能元数据
│       └── skill.zip          # 技能包（复用现有 .zip 格式）
└── capabilities/
    └── {capability-id}/
        └── manifest.json      # 编排图定义
```

`{agent-id}` 等目录名即 registry slug（小写字母/数字/连字符，仓库内全局唯一，跨类型不重复——validate.yml 强制）。

**跨类型唯一的原因**：注意这不是导入正确性的硬要求——provenance 查询都是类型定域的（`resolveSkill` 只搜 `listSkills()`、`resolveAgent` 只搜 `listAgents()`），manifest 引用也按字段分命名空间（`skillIds` 指向 skills、`dependencies.agents` 指向 agents），agent 与 skill 同 slug 不会互相命中。真正的约束理由是：① 浏览/搜索 UX 消歧（列表里两个同名条目即使带类型徽章也易混）；② 给未来「无类型上下文的引用」留余地（如聊天 `@slug` 一键安装、CLI `one install <slug>`）；③ 心智模型与 validate.yml 规则足够简单。代价是 slug 资源更紧张（"research" 不能同时被 agent 和 skill 占用）。若未来觉得拘束，放开为按类型分命名空间也安全（Homebrew 允许 formula/cask 同名即先例），不 break 导入逻辑。

### 1.1 index.json（CI 生成）

全局索引文件，app 通过镜像源读取（§4）。**贡献者不手改此文件**——每个 PR 都改同一文件必然冲突且易错；由 reindex.yml 在 merge 后扫描全量 manifest 重建：

```json
{
  "version": 1,
  "updated": "2026-08-02T12:00:00Z",
  "agents": [
    {
      "id": "code-reviewer",
      "name": "Code Reviewer",
      "description": "Reviews code for bugs, style, and performance",
      "author": "shijianzhong",
      "version": "1.0.0",
      "tags": ["code", "review", "quality"],
      "updatedAt": "2026-08-02T12:00:00Z"
    }
  ],
  "skills": [
    {
      "id": "web-research",
      "name": "Web Research",
      "description": "Deep web research with source citation",
      "author": "shijianzhong",
      "version": "1.2.0",
      "tags": ["research", "web", "search"],
      "hasScripts": false,
      "updatedAt": "2026-08-02T12:00:00Z"
    }
  ],
  "capabilities": [
    {
      "id": "research-pipeline",
      "name": "Research Pipeline",
      "description": "Multi-agent research → analysis → report workflow",
      "author": "shijianzhong",
      "version": "1.0.0",
      "tags": ["research", "pipeline", "multi-agent"],
      "updatedAt": "2026-08-02T12:00:00Z"
    }
  ]
}
```

> 条目必须带 `version`（从 manifest 原样拷贝）——列表页「有更新」判定 = 本地 `provenance.version` 与 index 条目 `version` 比对，缺了这个字段更新检测就失效。

### 1.2 Agent manifest.json

```json
{
  "id": "code-reviewer",
  "name": "Code Reviewer",
  "description": "Reviews code for bugs, style, and performance",
  "author": "shijianzhong",
  "version": "1.0.0",
  "tags": ["code", "review", "quality"],
  "instructions": "You are a senior code reviewer. Focus on...\n\n## Review Checklist\n- Correctness\n- Performance\n- Security\n- Readability",
  "skillIds": ["web-research"],
  "modelHint": "claude-sonnet-5",
  "temperature": 0.3,
  "maxTokens": 16384,
  "outputConstraints": "≤500 words per review",
  "updatedAt": "2026-08-02T12:00:00Z"
}
```

字段口径（与本地 `Agent` 类型的映射）：

| manifest 字段 | 口径 |
|---------------|------|
| `skillIds` | **registry slug 列表**，非本地 id；导入时重映射（§2） |
| `modelHint` | 可选，导出时取本地 ModelConfig 的真实模型名，**仅供详情页展示参考**；导入时不设 `modelId`（§3.2） |
| `temperature`/`maxTokens`/`outputConstraints` | 与本地同名字段直映射 |
| `modelId`（本地）/ `source` / `createdAt` | **不导出**——本地 id 与来源标记跨机器无意义 |

### 1.3 Skill manifest.json

```json
{
  "id": "web-research",
  "name": "Web Research",
  "description": "Deep web research with source citation",
  "author": "shijianzhong",
  "version": "1.0.0",
  "tags": ["research", "web", "search"],
  "skillZip": "skill.zip",
  "hasScripts": false,
  "hasDiscipline": true,
  "updatedAt": "2026-08-02T12:00:00Z"
}
```

- `skill.zip` 与 manifest 同目录，格式复用现有技能包导入规范（含 `SKILL.md`、`resources/`、`scripts/`）。
- `hasScripts`：zip 内含 `scripts/` 时为 true——列表页与导入确认框据此提示（§5）。
- `hasDiscipline`：SKILL.md 内含纪律定义时为 true——详情页据此展示「该技能含输出约束」标记，帮助用户在导入前了解技能的行为限制。
- `discipline` 正文存于 SKILL.md 内，两个来源的优先级：**frontmatter `discipline` 字段优先**，缺省回退 `## Discipline` 正文段落（与 name/description 的 frontmatter 解析惯例一致）。
- 注意两处「尚未实现」：① 现有 `parseSkillZip` 不提取 discipline（`ParsedSkill` 无此字段，frontmatter 抓到也丢弃），**Phase 2 需扩展提取逻辑 + `skills:pickFile` 透传**；② discipline 的运行时注入依赖 task.md 7.4（Skill ContextProvider，未做）——在此之前 `hasDiscipline` 仅为元数据展示，不代表运行时已强制执行输出约束。

### 1.4 Capability manifest.json

**图节点是内联快照结构（设计基线 2），不是引用式**。`skillIds`/`sourceAgentId` 在导出时已由本地 id 转为 registry slug：

```json
{
  "id": "research-pipeline",
  "name": "Research Pipeline",
  "description": "Multi-agent research → analysis → report workflow",
  "author": "shijianzhong",
  "version": "1.0.0",
  "tags": ["research", "pipeline", "multi-agent"],
  "graph": {
    "nodes": [
      {
        "id": "researcher",
        "type": "agent",
        "data": {
          "label": "研究员",
          "instructions": "你是资深调研员……",
          "description": "Deep web research with source citation",
          "skillIds": ["web-research"],
          "sourceAgentId": "code-reviewer",
          "temperature": 0.3,
          "maxTokens": 16384,
          "outputConstraints": "≤800 words"
        },
        "position": { "x": 0, "y": 0 }
      },
      {
        "id": "analyst",
        "type": "agent",
        "data": {
          "label": "分析师",
          "instructions": "你是数据分析师……"
        },
        "position": { "x": 320, "y": 0 }
      }
    ],
    "edges": [
      { "source": "researcher", "target": "analyst" }
    ]
  },
  "dependencies": {
    "agents": ["code-reviewer"],
    "skills": ["web-research"]
  },
  "updatedAt": "2026-08-02T12:00:00Z"
}
```

- `graph` 即 `WorkflowGraph` 序列化（节点 id / 容器节点 / 条件边原样保留）；导出时剥离节点 data 里的本地 `modelId`，`skillIds`/`sourceAgentId` 转 slug。
- `dependencies` 由导出器从图内容**自动推导**（节点 skillIds 全集 + sourceAgentId 全集），声明该能力运行/复用所需资产；导入时据此级联（§3.2）。
- **`sourceAgentId` 为空的节点不产生 agent 依赖**——用户在编排图中手动创建的节点（未关联角色库），其 instructions 快照就是全部运行时信息，`dependencies.agents` 不包含该节点。

---

## 2. 身份映射与 Provenance（P0）

本地 id（`agt_/skl_/cap_`）与 registry slug 是两个命名空间，必须显式桥接。这是「已安装判定」「级联去重」「更新检测」的共同基础。

### 2.1 Provenance 字段

`shared/types.ts` 新增，三类资产各挂一个可选字段；`config.ts` 对应 Zod schema 同步扩展：

```typescript
/** 资产来源溯源（registry 导入/发布过才有；纯本地创建无此字段） */
export interface RegistryProvenance {
  /** registry slug，如 "code-reviewer" */
  registryId: string
  /** 导入/发布时 manifest 的 version */
  version: string
  author?: string
  importedAt: number
}
// Agent / Skill / Capability 均增加：registry?: RegistryProvenance
```

注意与既有 `Agent.source: 'builtin' | 'custom'` 语义不同（那是内置/用户创建标记），不复用。

### 2.2 映射规则

**导入（slug → 本地 id）**：

```
resolveSkill(slug):
  已存在 listSkills().find(s => s.registry?.registryId === slug)
    → 复用其本地 id（跳过下载）
  否则 → 下载 zip → uploadSkillFile → saveSkill（写 provenance）→ 得新本地 id
```

agent / capability 同理（`getAgent`/`getCapability` 无列表缓存，直接 `listAgents()` 扫 provenance）。

**导出（本地 id → slug）**：

- 资产已有 provenance → 直接用其 `registryId`（再发布 = 更新同一 registry 条目）。
- 纯本地资产 → 在推送预览清单里由用户确认 slug（默认从 name 派生 kebab-case，校验仓库内唯一）。

### 2.3 已安装判定与更新检测

- 「已安装」= 本地存在 `registry.registryId === slug` 的资产（**不按 name 匹配**，name 可改、会撞）。
- 「有更新」= 同 slug 的远程 manifest `version` ≠ 本地 provenance `version`（辅以 `updatedAt` 展示）。
- 更新 = 按 §3.2 重新导入，但**保留本地 id 覆盖内容**（不新建实体，避免引用失效）；provenance.version 同步刷新。
- **Capability 更新时级联检查依赖资产**：更新 Capability 时，对 `dependencies.agents` 中的 slug 逐个检查远程版本，有更新的同步物化覆盖（保留本地 id）；无更新的跳过。`dependencies.skills` 同理。这确保 Capability 升级后不会继续引用过时的依赖。两条约束：
  - **本地修改冲突检测**：`updatedAt > provenance.importedAt` 说明导入后本地改过——默认**跳过并提示「本地已修改」**，由用户显式选择覆盖，不静默丢本地改动。
  - **级联是递归的**：agent 新版本可能引入新的 `skillIds`（旧版依赖 A、新版依赖 A+B）——级联解析与 §3.2 导入的「递归解析」对齐，新依赖一并走 `resolveSkill`。

---

## 3. App 端功能实现

### 3.1 Registry 浏览（Browse）

**入口**：侧栏管理页新增 "Registry" tab

**流程**：
1. 经镜像源读取 `index.json`（§4，多源 fallback）
2. 渲染列表，支持按类型（Agent / Skill / Capability）筛选、按标签搜索
3. 点击某项 → 读取对应 `manifest.json` 展示详情（含 `modelHint`、「含可执行脚本」标记）
4. 详情底部显示 "导入" 按钮；已安装的显示「已安装 / 有更新」态（§2.3）

**数据获取策略**：
- 首次加载拉取 `index.json`，本地缓存 10 分钟（与 raw CDN ~5min 缓存周期匹配）
- 点击详情时拉取具体 `manifest.json`
- Skill 的 `skill.zip` 在用户点"导入"时才下载
- 全部源不可达时：展示本地缓存 + 错误条（i18n key，不白屏）

### 3.2 导入（Import）

**Skill 导入**：
1. 下载 `skill.zip` 到临时目录
2. 复用 `skills/upload.ts`：`uploadSkillFile(tmpPath)` → `saveSkill`（写 provenance）
3. `hasScripts: true` 时先弹确认框（列出脚本文件名 + 「脚本将在本机执行」警告，§5）
4. 导入成功后刷新本地技能列表

**Agent 导入（级联自动导入依赖 Skill）**：
1. 读取 manifest.json
2. 遍历 `skillIds`（slug），逐个走 `resolveSkill`（§2.2）：已安装跳过，未安装自动下载导入（递归解析）
3. 组装本地 Agent：`skillIds` 重映射为本地 id；**`modelId` 置空**（运行时回退会话/默认模型——本地 ModelConfig id 不可移植，设计基线 4）；`temperature/maxTokens/outputConstraints` 直映射
4. `saveAgent`（写 provenance），生成新本地 id
5. 导入完成后显示汇总：`已导入 Agent "Code Reviewer"，自动安装了 2 个依赖技能：Web Research, File Analyzer`

**Capability 导入（级联 + 图重映射）**：
1. 读取 manifest.json
2. 级联 `dependencies.skills` → `resolveSkill` 得 slug→本地 id 映射表
3. 遍历 `graph.nodes` 重写节点 data：
   - `skillIds`：slug → 本地 id（映射表缺失的剔除并 warn——运行时 `orchestrate.ts` 对缺失 skill 本就 warn 降级，不阻断）
   - `sourceAgentId`：按 §2.2 物化 agent 后重映射为新本地 id；用户选择「仅导入图」时剔除该字段（内联快照自包含，图仍可运行，设计基线 2）
   - 内联快照（instructions/temperature/maxTokens/outputConstraints/label）原样保留
4. `dependencies.agents`：默认物化到角色库（便于复用，各生成新本地 id + provenance）；导入确认框提供「仅导入图，不安装角色」选项
5. `saveCapability`（写 provenance）
6. 导入完成后显示汇总：`已导入 Capability "Research Pipeline"，自动安装了 1 个角色 + 2 个技能`

### 3.3 导出（Export）— 级联推送

**入口**：管理页各资产的右键菜单 / 操作按钮增加 "发布到 Registry"

**级联规则**：

| 用户操作 | 自动附带推送 |
|---------|------------|
| 推送 Skill | 仅该 Skill 本身 |
| 推送 Agent | 该 Agent + 其 `skillIds` 引用的所有 Skill |
| 推送 Capability | 该 Capability + 图内引用的所有 Skill + `dependencies.agents` 物化所需 Agent（从 `sourceAgentId` 推导） |

**导出序列化规则**（与 §1 manifest 口径互逆）：

- Agent：本地 `skillIds` → slug（§2.2）；`modelId` 转为 `modelHint`（取 ModelConfig 真实模型名）；剥离 `id/source/createdAt`
- Skill：重组 zip——SKILL.md（frontmatter + content/discipline）+ 按 `scriptPath` 反查资源目录打包 `resources/`、`scripts/`（设计基线 5，不假设目录名 == skill id）；`hasScripts` 按 zip 内容置位
- Capability：图节点 `skillIds`/`sourceAgentId` → slug；剥离节点 `modelId`；`dependencies` 从图内容自动推导

**流程**：
1. 根据级联规则收集全部需要推送的资产（去重：同一 Skill 被多个 Agent 引用只推一次）
2. 逐个序列化为标准 manifest.json（Skill 同时打包 zip）
3. 展示推送预览清单，让用户确认（含每个新资产的 slug 可编辑、已有 provenance 的标「更新」）：
   ```
   即将推送到 Registry：
   ☑ Capability: Research Pipeline（slug: research-pipeline）
   ☑ Agent: Code Reviewer（自动附带，slug: code-reviewer）
   ☑ Skill: Web Research（自动附带，更新已有条目）
   ☑ Skill: File Analyzer（自动附带，slug: file-analyzer）
   ```
   取消勾选的依赖：从导出图的 `skillIds`/`sourceAgentId` 中剔除并警告（运行时降级不报错）。
4. 用户确认后，引导提交 PR：
   - 方式 A（简单）：下载全部文件到本地，引导用户手动 fork + 提交 PR（目录结构已按仓库规范生成，解压即合规）
   - 方式 B（进阶）：app 内通过 GitHub API 自动 fork → 创建文件 → 提交 PR（需用户配置有写权限的 Token，§4.3）
5. 发布成功后**回写本地 provenance**（slug + version），下次再发布自动识别为更新

### 3.4 刷新与更新检测

- 每次打开 Registry 页面，对比本地缓存的 `updated` 字段与远程值，有更新时自动刷新列表
- 已导入资产（有 provenance）与远程同 slug 条目做 `version` 比对，不一致显示更新提示（§2.3）
- 一键更新 = 按 §3.2 重导入并保留本地 id 覆盖

---

## 4. 网络层：镜像源与速率限制

### 4.1 RegistrySource 抽象（国内可达性，P0）

`raw.githubusercontent.com` 在国内访问不稳定（本项目 web 工具默认 Bing CN 正是同一现实）。Registry 读取层必须做源抽象，**不写死单一域名**：

```typescript
interface RegistrySource {
  id: string
  /** URL 模板，{repo}/{ref}/{path} 占位 */
  urlTemplate: string
}

const DEFAULT_SOURCES: RegistrySource[] = [
  { id: 'github-raw', urlTemplate: 'https://raw.githubusercontent.com/{repo}/{ref}/{path}' },
  { id: 'jsdelivr',   urlTemplate: 'https://cdn.jsdelivr.net/gh/{repo}@{ref}/{path}' },
]
```

- 拉取策略：按优先级逐源尝试（每源 8s 超时 + AbortController），全部失败 → 展示缓存 + 错误条
- jsDelivr 注意：`@branch` 有约 12h CDN 缓存，更新检测场景以 github-raw 优先、jsDelivr 兜底（接受延迟）；可按 `@commit` pin 提速
- 设置页可改 `ref`（默认 main）、追加自定义源（ghproxy 前缀 / 自建镜像 / 内网镜像）
- zip 下载与 JSON 读取走同一源抽象

### 4.2 速率限制

| 场景 | 无 Token | 有 Token |
|------|---------|---------|
| GitHub API 请求 | 60 次/小时（按 IP） | 5000 次/小时 |
| raw.githubusercontent.com / jsDelivr | 无明确限制 | 无明确限制 |
| 下载 zip 文件 | 无明确限制 | 无明确限制 |

**关键设计**：浏览和下载走 raw/CDN，不消耗 API 配额。仅以下场景使用 API：
- 搜索（如果未来支持全文搜索）
- 自动 PR 提交（方式 B）

因此绝大多数用户无需配置 Token 即可正常使用。

### 4.3 Token 配置与权限分场景

**权限口径（修正原方案自相矛盾处）**：

| 用途 | Token 要求 |
|------|-----------|
| 只读加速（API 搜索等） | classic 无 scope 即可 / fine-grained 只读 |
| 方式 B 自动 PR | classic 勾 `repo`；或 fine-grained 对「你的 fork」授 **Contents: Read/Write + Pull requests: Read/Write** |

「无需勾选任何权限」仅对只读场景成立，自动 PR 必须有写权限——设置页与超限提示的引导文案按上表区分。

**超限处理**：API 请求返回 `403 rate limit exceeded` 时，Registry 页面顶部显示提示条（i18n key）：

```
浏览频率已达 GitHub 上限（60 次/小时）。配置 GitHub Token 可提升至 5000 次/小时。
[如何配置？]
```

点击展开配置引导（GitHub → Settings → Developer settings → PAT），Token 存 vault（铁律 3，复用 `secrets/vault.ts`）。

### 4.4 设置入口

**路径**：设置页 → 高级 → Registry

- GitHub Token（可选，状态显示已配置/未配置）
- Registry 源列表（优先级排序、自定义源追加、ref 配置）

---

## 5. 安全模型

社区贡献的 skill.zip 可含 `scripts/`（铁律 23 会 async 执行），必须有显式信任链设计：

**仓库侧**：
- main 分支保护：PR + 至少 1 维护者 review 才可合并
- 审核标准写进 README：**含 `scripts/` 的 skill，维护者必须人工通读脚本全文**；manifest 与目录结构由 validate.yml 机审，内容安全由人审
- 合并即背书；发现恶意条目维护者有权直接移除

**App 侧**：
- 导入 `hasScripts: true` 的 skill（含级联带入的）→ 确认对话框：列出脚本文件名 + 「此技能包含可执行脚本，将在本机运行」警告，用户显式确认才继续
- 沿用现有 zip 校验：10MB 上限 / 200 文件上限 / 路径穿越防护（`skills/upload.ts` 已有）

**明确不做（MVP 范围外，避免过度设计）**：签名体系、脚本沙箱执行、恶意内容自动扫描。

---

## 6. Registry 仓库 README 与 CI

### 6.1 README 内容

```markdown
# One Registry

Community-shared agents, skills, and capabilities for the ONE desktop app.

## Browse

Visit the Registry tab in your ONE app to browse and import shared assets.

## Contributing

**不需要手改 index.json**——merge 后 CI 会自动重建索引。

### Share an Agent
1. Export from ONE app → generates `manifest.json`
2. Place in `agents/{your-agent-id}/manifest.json`
3. Submit a Pull Request

### Share a Skill
1. Export from ONE app → generates `manifest.json` + `skill.zip`
2. Place both in `skills/{your-skill-id}/`
3. Submit a Pull Request

### Share a Capability
1. Export from ONE app → generates `manifest.json`
2. Place in `capabilities/{your-capability-id}/manifest.json`
3. Submit a Pull Request

## Review Policy

- 目录名即全局唯一 slug（小写/数字/连字符），CI 校验 manifest schema 与 zip 存在性
- **含 scripts/ 的 skill 将由维护者人工通读脚本全文后才合并**
- 恶意内容、窃取密钥、外传数据的条目一律拒绝并拉黑

## Rate Limits

Browsing uses GitHub raw / jsDelivr CDN and has no practical rate limit.
API-heavy features may hit the 60 requests/hour unauthenticated limit;
configure a GitHub token in ONE Settings → Advanced → Registry.
```

### 6.2 CI 工作流

`validate.yml`（PR 触发）：zod 校验 manifest schema（schema 从 app 仓库 `shared/types.ts` 拷贝同步）、目录名 == manifest.id、slug 全局唯一、skill 条目 zip 文件存在、zip 内 SKILL.md 存在、**已有条目的 manifest 内容变更时 version 必须递增**（对比 base 分支，堵住「改内容忘 bump」导致的更新漏报，§2.3）。

`reindex.yml`（push to main 触发）：

```yaml
name: Reindex
on:
  push:
    branches: [main]
permissions:
  contents: write
concurrency:
  group: reindex
  cancel-in-progress: false
jobs:
  reindex:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: node scripts/build-index.mjs
      - uses: stefanzweifel/git-auto-commit-action@v5
        with:
          commit_message: "chore: regenerate index.json"
          file_pattern: index.json
```

`concurrency` 把 reindex 串行化（`cancel-in-progress: false` = 排队不取消）：后一个 run 的 checkout 拿到的 main 已包含前一个 run 的 auto-commit，push 冲突被结构性避免，无需额外重试机制。

---

## 7. 实现阶段

### Phase 1：Registry 仓库 + 规范（1-2 天）

- 创建 `one-registry` GitHub 仓库 + main 分支保护
- 建立目录结构、编写 `build-index.mjs` + validate/reindex 两个 workflow
- 编写 Registry README（贡献指南 + 审核标准）
- manifest JSON Schema 定义为 TypeScript 类型 + zod schema，放入 `src/shared/types.ts`（仓库侧 validate.yml 拷贝同步）

### Phase 2：Provenance + 浏览 + 导入（5-8 天）

- `shared/types.ts` + `config.ts`：三实体加 `registry?: RegistryProvenance`（§2.1）
- 新增 Registry 数据层：`src/main/registry/`（源抽象 + index/manifest 拉取 + 缓存 + zip 下载）
- 新增 Registry IPC 通道：`src/main/ipc/registry.ts`（withHandler + IpcResult，铁律 2）
- 新增 Registry 前端页面：浏览列表 + 详情 + 导入按钮 + 已安装/有更新态
- 导入逻辑：§3.2 三条链路（slug→本地 id 重映射、modelId 置空回退、脚本确认框）
- 扩展 `parseSkillZip` 提取 discipline（frontmatter 优先，回退 `## Discipline` 段落）+ `skills:pickFile` 透传（§1.3）
- 本地缓存 + 更新检测（§2.3，含本地修改冲突检测与递归级联）

### Phase 3：导出（2-3 天）

- Agent 导出：序列化 + skillIds 转 slug + modelHint 转换
- Skill 导出：按 scriptPath 反查重组 zip + manifest
- Capability 导出：图节点 slug 化 + dependencies 自动推导
- 推送预览清单（slug 确认/编辑 + 去重 + 取消勾选剔除）
- 导出后引导提交 PR（下载文件 + 打开 GitHub 贡献页面）；发布成功回写 provenance

### Phase 4：Token + 镜像源（1-2 天）

- 设置页 Registry 区：Token 输入（存 vault）+ 源列表管理
- Registry 请求多源 fallback + 自动附带 Token（如已配置）
- 403 响应提示条 + 分场景权限引导（§4.3）

### Phase 5：体验优化（可选）

- 自动 PR 提交（app 内 fork → commit → create PR）
- 评分 / 下载量统计（通过 GitHub API 读取 release/stargazer）
- 一键更新已导入资产

---

## 8. 数据流总览

```
┌──────────────────────────────────────────────────────────────┐
│                     one-registry (GitHub)                    │
│                                                              │
│  index.json  ←──── CI 自动重建（贡献者不手改）                 │
│  agents/*/manifest.json                                      │
│  skills/*/manifest.json + skill.zip                          │
│  capabilities/*/manifest.json                                │
└──────────────┬──────────────────────────────┬────────────────┘
               │ 读取（多源 fallback，无需 Token）│ 提交 PR（需写权限 Token）
               ▼                              ▼
┌──────────────────────────┐    ┌──────────────────────────────┐
│  ONE App — Registry 浏览  │    │  ONE App — 导出 + 发布        │
│                          │    │                              │
│  列表 → 详情 → 导入       │    │  导出 manifest → 下载/提 PR   │
│  本地缓存 10 min          │    │  发布成功回写 provenance      │
└──────────────────────────┘    └──────────────────────────────┘
               │
               ▼ slug→本地 id 重映射 + provenance 落盘
┌──────────────────────────┐
│  ONE App — 本地 JSON 存储 │
│                          │
│  userData/config/        │
│    agents/{id}.json      │
│    skills/{id}.json      │
│    capabilities/{id}.json│
│  （JsonCollection；      │
│   SQLite 只存会话/任务/记忆）│
└──────────────────────────┘
```

---

## 9. 工程规范（横切）

- **i18n（铁律 T2）**：新增 `registry` namespace（`public/locales/{zh-CN,en}/registry.json`），Registry 页所有用户可见文案走 key，禁止硬编码中文；导入/导出错误经 `withHandler` 返回结构化 `IpcResult`，错误文案走 `errors.*` key
- **IPC 收口（铁律 2）**：渲染层只调 `window.one.registry.*`；网络请求全部在主进程，渲染层零直连
- **密钥（铁律 3）**：GitHub Token 只存 vault，不进渲染进程
- **存储**：导入落盘走既有 `saveAgent/saveSkill/saveCapability`（原子写盘已有）；provenance 字段随实体同文件存储
- **进度登记**：本方案各 Phase 已登记 `task.md` 阶段 8，动工与收口以 task.md 勾选为准

---

## 10. Phase 2 Code Review 待修复项（2026-08-03）

> **2026-08-03 已全部修复**：P1/P2/P3 及两个代码小问题均已落地（typecheck + 226 测试全绿）。各条修复要点见对应小节末尾「✅ 已修」。

Phase 2 实现已 review，核心链路（浏览 → plan → 确认 → apply → 级联 + 重映射）与设计文档对齐良好。以下为需修复/补全的问题：

### P1：Skill 更新时旧资源文件未清理 ✅ 已修

`applySkillImport` 更新已有 skill 时，`uploadSkillFile` 以新临时 id 创建解压目录，旧 skill 的 `scriptPath` 指向旧目录——旧目录文件永远不会被清理，多次更新后磁盘积累孤立文件。

**修复**：在 `applySkillImport` 中，更新场景下先记录旧 `scriptPath` 目录，`saveSkill` 成功后删除旧目录：

```typescript
const oldScriptDir = existing?.scriptPath ? dirname(existing.scriptPath) : null
const { parsed, scriptPath } = await uploadSkillFile(zipPath)
// ... saveSkill ...
if (oldScriptDir && oldScriptDir !== dirname(scriptPath)) {
  await rm(oldScriptDir, { recursive: true, force: true }).catch(() => {})
}
```

**✅ 已修（2026-08-03）**：`upload.ts` 新增 `getSkillUploadTempDir()`（由 scriptPath 反推 `skl_upload_` 前缀临时目录，非约定路径返回 null 防误删）；`applySkillImport` 更新场景在 `saveSkill` 成功后清理旧目录。顺带修复同源泄漏：`removeSkill` 删除技能时也清理其临时目录。

### P2：本地修改冲突检测未实现 ✅ 已修

§2.3 明确要求「`updatedAt > provenance.importedAt` 说明导入后本地改过——默认跳过并提示『本地已修改』」。当前 `applyImport` 只做 version 相等判定，version 不同就直接覆盖，不检测本地是否改过。

**修复**：在 `applySkillImport`/`applyAgentImport`/`applyCapabilityImport` 中加判断：

```typescript
if (existing && existing.updatedAt > existing.registry!.importedAt) {
  // 本地改过——跳过并标记 reason: 'locally_modified'
  // 或返回给渲染层让用户选择覆盖
}
```

`RegistryImportResult.skipped` 的 `reason` 字段需扩展 `'locally_modified'` 枚举值。

**✅ 已修（2026-08-03）**：`skipped.reason` 已扩展 `'locally_modified'`；`applySkillImport`/`applyAgentImport`/`applyCapabilityImport` 入口统一 `isLocallyModified()` 判定（级联依赖遇本地修改保留本地版复用 id，顶层资产跳过并在结果消息中提示「本地已修改，未覆盖」）。**关键细节**：导入落盘经 `save*(…, { now })` 注入同一时间戳使 `importedAt == updatedAt`，否则 save 内部 `Date.now()` 晚于 provenance 捕获点会导致导入后立即误判「本地已修改」。渲染层 `result.skippedModified` i18n key 双语已加。

### P3：`planSkillItem` 下载 zip 失败时错误信息不友好 ✅ 已修

`planSkillItem` 在 plan 阶段下载 zip 并解压以列出脚本文件名。zip 损坏或格式不对时，用户看到晦涩的底层错误。

**修复**：加 try-catch，plan 阶段解压失败时不阻断（scripts 字段留空），apply 阶段再失败才报错：

```typescript
let scripts: string[] | undefined
try {
  const parsed = await parseSkillZip(zipPath)
  scripts = parsed.scripts?.length ? parsed.scripts : undefined
} catch {
  // plan 阶段不阻断，apply 阶段 uploadSkillFile 会再次校验并报错
}
```

**✅ 已修（2026-08-03）**：`planSkillItem` 已按上述方案 try-catch（warn 日志 + scripts 留空）；`downloadSkillZip` 网络失败仍在 plan 阶段抛出（无法导入，属应报错误）。

### 代码小问题（非阻断）✅ 已修

- **`remap.ts:39` 空数组处理**：~~建议加注释说明意图~~ → 已加注释（`[]` 与全缺映射统一走 delete，与「未配置」同语义）。
- **`RegistryPage.tsx:376` 类型断言**：~~建议改用判别联合或分 kind 渲染组件~~ → 已改为按 kind 收窄（`agentM`/`capM` 分别断言为对应 manifest 类型），移除交叉类型断言。
