import type {
  Agent,
  Capability,
  GraphEdge,
  GraphNode,
  HomeStreamEvent,
  OrchMessage,
  Persona,
  SkillMeta,
  StreamEvent,
  WorkflowGraph,
} from '@shared/types'
import {
  MENTION_NAME_RE,
  MENTION_TOKEN_RE,
  type ExplicitMention,
  type MentionKind,
} from '@shared/mentions'
import { buildWorkflow, resolveStartExecutor, type BuildDeps } from './builder'
import { runWorkflow } from './runner'
import { logger } from '../logger'

// —— 首页主助手意图路由（§三之三 M + 铁律24）——
// 两阶段：主 Agent 先产出；产出若以 {"role_ids":/{"capability_ids": 开头的 {
// 视为组队 JSON 起始（24 字符尾部缓冲防跨 chunk 截断），否则直答流式回用户。
// 组队 → 解析 JSON → 动态拼编排图 → 走 runner 执行 → 流式事件转前端。

/** 组队 JSON 前缀（铁律24：只有这两个前缀的 { 才算组队起始） */
const TEAM_JSON_PREFIXES = ['{"role_ids":', '{"capability_ids":'] as const
/** 尾窗长度：最长前缀 18 + 余量，防跨 chunk 截断 */
const TAIL_BUFFER_LEN = 24

/** 组队 JSON 结构（主 Agent 产出） */
export interface TeamJson {
  role_ids?: string[]
  capability_ids?: string[]
}

/** 意图路由判定结果 */
export type IntentDecision =
  | { kind: 'direct' } // 直答：缓冲文本即最终答复
  | { kind: 'team'; json: TeamJson } // 组队：解析出的 role_ids/capability_ids
  | { kind: 'undetermined' } // 尚未产出足够文本判定（流式中）

/**
 * 流式组队 JSON 判定器（铁律24）。
 * 逐 chunk 喂文本，内部维护 24 字符尾窗；判出组队起始后不再累积直答缓冲。
 *
 * 用法：
 *   const det = new TeamJsonDetector()
 *   for (chunk of stream) { det.feed(chunk) }
 *   det.decide() // 流结束后调用
 */
export class TeamJsonDetector {
  /** 已判为直答的文本缓冲（组队时丢弃） */
  private directBuffer = ''
  /** 组队 JSON 累积缓冲（判出起始后开始） */
  private teamBuffer = ''
  /** 是否已判出组队起始 */
  private teamStarted = false

  /**
   * 喂入一个 text chunk。返回当前应推给前端的直答文本（未判组队时原样返回；
   * 一旦判出组队起始，之后返回 ''，文本进 teamBuffer 不再推前端）。
   */
  feed(chunk: string): string {
    if (this.teamStarted) {
      this.teamBuffer += chunk
      return ''
    }

    // 候选起点：缓冲 + 新 chunk 里找组队前缀。
    // 用（尾部缓冲 + chunk）判，防前缀跨 chunk（如 '{"role_' 在上一 chunk 末尾）。
    const candidate = this.directBuffer + chunk
    const prefixIdx = this.findTeamPrefix(candidate)
    if (prefixIdx >= 0) {
      // 判出组队：前缀前的文本是直答 preamble（通常为空，主 Agent 直接产 JSON）
      this.teamStarted = true
      this.teamBuffer = candidate.slice(prefixIdx)
      this.directBuffer = candidate.slice(0, prefixIdx)
      return ''
    }

    // 未判出：仍可能是直答。但不能立刻全推——尾部 24 字符可能是组队前缀的
    // 前半段（跨 chunk），先扣住尾窗，只推安全部分。
    this.directBuffer = candidate
    const safeLen = Math.max(0, this.directBuffer.length - TAIL_BUFFER_LEN)
    const safe = this.directBuffer.slice(0, safeLen)
    this.directBuffer = this.directBuffer.slice(safeLen)
    return safe
  }

  /** 流结束后判定（此时无更多 chunk，尾窗可安全推为直答或组队） */
  decide(): IntentDecision {
    if (this.teamStarted) {
      const json = this.parseTeamJson(this.teamBuffer)
      if (json) return { kind: 'team', json }
      // 组队 JSON 解析失败（模型吐了个像组队但非法的 JSON）→ 回退直答
      logger.warn('[home-router] 组队 JSON 解析失败，回退直答', this.teamBuffer.slice(0, 200))
      return { kind: 'direct' }
    }
    return { kind: 'direct' }
  }

  /** 取最终直答全文（decide 后调用；含尾窗残留） */
  flushDirect(): string {
    return this.directBuffer
  }

  /** 取组队 JSON 原文（decide 为 team 后调用，用于存档） */
  getTeamRaw(): string {
    return this.teamBuffer
  }

  /** 在文本里找组队前缀起始下标；找不到返回 -1 */
  private findTeamPrefix(text: string): number {
    for (const prefix of TEAM_JSON_PREFIXES) {
      const idx = text.indexOf(prefix)
      if (idx >= 0) return idx
    }
    // 半匹配：文本尾部是否是某前缀的前缀（跨 chunk 待确认）→ 不判起始，等下一 chunk
    return -1
  }

  /**
   * 鲁棒解析组队 JSON：剥 markdown 围栏 + 抽第一个 {...} 配对块。
   * 只认含 role_ids/capability_ids 的对象。
   */
  private parseTeamJson(raw: string): TeamJson | null {
    let text = raw.trim()
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fence) text = fence[1].trim()

    const tryParse = (s: string): TeamJson | null => {
      try {
        const obj = JSON.parse(s) as Record<string, unknown>
        const roleIds = Array.isArray(obj.role_ids)
          ? (obj.role_ids as unknown[]).filter((x): x is string => typeof x === 'string')
          : undefined
        const capIds = Array.isArray(obj.capability_ids)
          ? (obj.capability_ids as unknown[]).filter((x): x is string => typeof x === 'string')
          : undefined
        if (!roleIds && !capIds) return null
        if ((roleIds?.length ?? 0) === 0 && (capIds?.length ?? 0) === 0) return null
        return { role_ids: roleIds, capability_ids: capIds }
      } catch {
        return null
      }
    }

    // 先试整体
    const whole = tryParse(text)
    if (whole) return whole

    // 再抽第一个平衡的 {...} 块（模型可能在 JSON 后追加解释文本）
    const start = text.indexOf('{')
    if (start < 0) return null
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (esc) {
        esc = false
        continue
      }
      if (ch === '\\') {
        esc = true
        continue
      }
      if (ch === '"') {
        inStr = !inStr
        continue
      }
      if (inStr) continue
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          return tryParse(text.slice(start, i + 1))
        }
      }
    }
    return null
  }
}

/**
 * 路由指令段（§三之三 M + 铁律24）：注入主 Agent system prompt。
 * 让主 Agent 知道当前有哪些角色/能力可组队，以及组队时该输出什么 JSON。
 * 仅在存在可用角色/能力时注入；直答场景不打扰主 Agent 人设。
 *
 * 输出约定（与 TeamJsonDetector 前缀严格对齐）：
 *   组队 → 只输出一行 JSON，以 {"role_ids": 或 {"capability_ids": 开头，无其它文字。
 *   直答 → 正常回答，绝不输出上述前缀的 JSON。
 */
export function buildRoutingInstruction(
  agents: Agent[],
  capabilities: Capability[],
): string {
  const lines: string[] = []
  if (agents.length > 0) {
    // 只列名（注入优化：去描述，显著减 prompt 体积；LLM 路由主要靠名字语义 + @提及）
    lines.push('【可用角色】' + agents.map((a) => `${a.name}（id=${a.id}）`).join('、'))
  }
  if (capabilities.length > 0) {
    lines.push('【可用能力】' + capabilities.map((c) => `${c.name}（id=${c.id}）`).join('、'))
  }
  if (lines.length === 0) return ''

  return [
    '',
    '【意图路由】你是一名意图路由器。根据用户问题判断：',
    ...lines,
    '',
    '判断规则：',
    '1. 若问题可凭你自身能力直接回答 → 正常直答，绝不输出任何 JSON。',
    '2. 若问题明显需要某个/某些角色协作（如跨领域、需多视角、用户点名要某人）→ 输出一行组队 JSON：',
    '   {"role_ids": ["角色id1", "角色id2"]}',
    '3. 若问题匹配某个能力的用途 → 输出一行能力 JSON：',
    '   {"capability_ids": ["能力id"]}',
    '4. 组队 JSON 必须独占全文：以 {"role_ids": 或 {"capability_ids": 开头，前后不加任何解释、标点、markdown 围栏。',
    '5. 只在 id 列表里引用上面列出的真实 id，不得编造。',
    '6. 角色与能力可同时出现：{"role_ids":[...],"capability_ids":[...]}。系统会先跑能力的真实编排图，再进入角色协作；不要把能力 id 写进 role_ids，也不要把角色 id 写进 capability_ids。',
    '7. 用户点名多个能力时，把需要的能力 id 全部放入 capability_ids（勿只留一个，除非用户明确只要其中一个）。',
  ].join('\n')
}

/**
 * @能力 聚焦块：用户显式 @了某能力时注入，替代通用 buildRoutingInstruction。
 * 路由目标已锁定该能力，主 Agent 的任务是二选一：
 *   问能力本身（"你能做什么"/光秃秃 @）→ 用下方能力档案口头介绍，绝不跑 workflow、绝不输出 JSON；
 *   要能力干活（给任务/资料/主题）→ 输出 {"capability_ids":["该能力id"]} 触发跑 workflow。
 * 能力档案含 description + graph 结构摘要（阶段/参与角色），供介绍时有据可依。
 */
export function buildCapabilityFocusBlock(cap: Capability): string {
  return [
    '',
    `【已聚焦能力】用户 @ 了能力「${cap.name}」（id=${cap.id}）。`,
    '',
    '<capability_profile>',
    `名称：${cap.name}`,
    cap.description ? `用途：${cap.description}` : '',
    `结构：${summarizeCapabilityGraph(cap)}`,
    '</capability_profile>',
    '',
    '判断规则：',
    '1. 若用户在问这个能力本身（能做什么/是什么/介绍/怎么用，或只 @ 了它没提具体任务）',
    '   → 依据 <capability_profile> 口头介绍它的整体能力、协作流程、适用场景，正常直答，绝不输出 JSON。',
    '2. 若用户给了要它执行的具体任务（主题/资料/目标，如"帮我写一篇X""处理这份数据"）',
    `   → 只输出一行组队 JSON：{"capability_ids": ["${cap.id}"]}，独占全文，前后不加任何解释、标点、markdown 围栏。`,
  ]
    .filter((l) => l !== '')
    .join('\n')
}

/** 能力 graph 结构摘要：容器阶段 + 参与角色，供主 Agent 介绍能力时描述协作流程。 */
function summarizeCapabilityGraph(cap: Capability): string {
  const nodes = cap.graph?.nodes ?? []
  if (nodes.length === 0) return '（空编排）'
  const parts: string[] = []
  for (const n of nodes) {
    const d = (n.data ?? {}) as Record<string, unknown>
    const label = typeof d.label === 'string' ? d.label : n.id
    if (n.type === 'agent') {
      // 顶层 agent（无 parent）才单列；容器内 participant 由容器行归并
      if (!d.parentId) parts.push(`角色「${label}」`)
    } else {
      // 容器：kind + 参与者
      const kids = nodes
        .filter((c) => (c.data as Record<string, unknown>)?.parentId === n.id)
        .map((c) => (c.data as Record<string, unknown>)?.label ?? c.id)
      const kindLabel =
        n.type === 'concurrent'
          ? '并行'
          : n.type === 'sequential'
            ? '顺序'
            : n.type === 'groupchat'
              ? '群聊'
              : n.type === 'handoff'
                ? '接力'
                : n.type
      parts.push(
        kids.length > 0
          ? `${kindLabel}阶段「${label}」（含 ${kids.map((k) => `「${k}」`).join('、')}）`
          : `${kindLabel}阶段「${label}」`,
      )
    }
  }
  return parts.length > 0 ? parts.join(' → ') : '（空编排）'
}

// needsCreateRecovery / inferCreateKind 见 ./createRecovery.ts（A2/A3）
export {
  needsCreateRecovery,
  inferCreateKind,
  inferCreateKindFromText,
  createKindFromToolName,
  proposeToolNameForKind,
  type CreateKind,
} from './createRecovery'

/**
 * 创建指令段（聊天创建/修改能力/角色/Skill/人设）。
 * 引导主 Agent：识别创建/修改意图 → 多轮澄清 → 调 propose_* 工具产出草稿 →
 * 告知用户「已生成预览，请在下方卡片确认」。草稿不落库，确认才入库。
 *
 * persona 原文注入（防污染）：LLM 看到的 system prompt 是 L0+L2+skill+路由+本段
 * 的拼装体，无法分离人设原文。把 persona.instructions 用 <persona> 边界标记附上，
 * 作为 propose_persona 的修改基准——否则「叫我XX」场景会把注入段固化进 persona，
 * 造成双重注入与新旧 L0 身份块矛盾。
 */
export function buildCreateInstruction(persona?: Persona | null): string {
  const personaAnchor = persona?.instructions?.trim()
    ? [
        '',
        '【当前人设原文】（<persona> 标签内是完整原文，propose_persona 的唯一修改基准；标签外的一切内容（身份块/记忆/技能/路由/本说明）都不是人设，严禁复制进 instructions）',
        '<persona>',
        persona.instructions,
        '</persona>',
      ]
    : []
  return [
    '',
    '【创建/修改能力/角色/技能/人设】你可以帮用户在对话中创建或修改以下四类资产，创建/修改后经用户确认才会入库：',
    '- 角色（Agent）：有人格与职责的对话角色，调 propose_agent。',
    '- 能力（Capability）：多角色协作的编排工作流，调 propose_capability。',
    '- 技能（Skill）：可复用的知识与纪律（SKILL.md），调 propose_skill。',
    '- 人设（Persona）：你自己的灵魂设定（人格、语气、职责定位），调 propose_persona。该工具也可同时更新用户档案（称呼/角色/偏好语种）。',
    '',
    '创建/修改规则：',
    '1. 识别意图：当用户表达"创建一个/帮我做一个/新增一个 X"且指向上述四类时，进入创建流程。当用户说"改一下你的人设/你以后用xx风格回答/调整一下你的角色"时，进入人设修改流程。当用户说"叫我XX/我是做XX的/以后用英文回复"等想改称呼、角色或偏好语种时，也走 propose_persona。',
    '2. 先澄清再产出：通过追问明确需求（角色定位与职责、能力目标与参与角色与协作模式、技能用途与内容、人设风格与语气），不要一次就调工具。信息足够后才调用对应 propose_* 工具。',
    '3. propose_* 只生成预览卡片，不会直接入库。调用后必须告诉用户「已生成预览，请在下方确认卡中点确认入库」——卡片由系统弹出，你无法代替用户确认。',
    '4. 【严禁幻觉入库】本环境已具备 propose_* → 确认卡 → 入库链路，绝不是「没有持久化/只能模拟」。在未成功调用 propose_* 之前，禁止声称已创建/已保存/已入库，也禁止声称没有存储机制；调用后到用户点确认之前，只能说「预览已生成，待你确认」。',
    '5. 能力编排图 graph 约定：nodes 为 agent 节点（data 含 label + instructions，或引用已有角色）与编排容器节点（sequential/concurrent/groupchat/handoff，容器 data 含 participantIds 等）；edges 描述连线。必须产出结构合法的 graph。',
    '6. 人设修改：propose_persona 的 instructions 是完整的新人设正文（全量替换）。改人设时必须基于【当前人设原文】修改，产出完整版，而非"增加以下内容"之类的片段。只改称呼/角色/语种时 instructions 不传，只带 alias/role/preferredLanguage——系统会自动保留人设原文，无需回传。',
    '7. 用户在卡片上可修改字段；用户确认后系统会自动入库，你无需重复调用。',
    ...personaAnchor,
  ].join('\n')
}

/**
 * 记忆策略指令段（铁律21 L3 激活）：告诉主 Agent 何时该记、何时该取。
 * L3 长期记忆工具（memory_*）是被动工具——若不在 system prompt 明确策略，
 * LLM 不会主动调用，L3 即成「死档」。本段把它激活：
 *   - 何时取：用户引用过往（「我之前/我喜欢/你还记得」）或回答需要用户背景时，
 *     先 memory_search 再作答。
 *   - 何时记：用户透露稳定偏好/身份/项目约定/长期目标时，memory_retain。
 *   - 不记：一次性、易变、仅当前会话相关的内容。
 * @param existingKeys 当前已有记忆 key（注入让 LLM 避免重复写入，空数组则不提示）
 */
export function buildMemoryInstruction(existingKeys: string[] = []): string {
  const keysHint =
    existingKeys.length > 0
      ? [
          '',
          `【已有记忆】（共 ${existingKeys.length} 条，避免重复写入；回答可引用时可先确认）：`,
          existingKeys.slice(0, 20).join('、') + (existingKeys.length > 20 ? ' …' : ''),
        ]
      : []
  return [
    '',
    '【长期记忆】你拥有一套跨会话的长期记忆（memory_* 工具），像人一样记住用户。策略：',
    '1. 何时取用：当用户引用过往信息（「我之前说过」「我喜欢」「你还记得吗」「按惯例」），或当前回答明显需要结合用户的偏好/身份/项目背景时，先调 memory_search 检索相关记忆，再据此作答——不要凭空猜测或反问用户已告诉过你的事。',
    '2. 何时记录：当用户在对话中透露跨会话仍有价值的稳定信息时，主动调 memory_retain 记下。值得记的：稳定偏好（如「喜欢晨跑」「不吃辣」）、身份信息（职业/所在地/经历）、项目约定（技术栈/代码规范/部署方式）、长期目标。**例外**：称呼/角色/偏好语种属于「个人档案」（设置页可见），用户要求改这些时一律走 propose_persona（只需带 alias/role/preferredLanguage），不要用 memory_retain 记——否则设置页不同步。',
    '3. 不要记：一次性请求、临时状态、易变信息（「今天很累」）、仅当前会话相关的上下文、以及你已经记住的内容（重复记忆前先 memory_search 确认）。',
    '4. 记录方式：memory_retain 需指定 category（preference 偏好 / identity 身份 / project 项目约定 / goal 目标 / fact 其它），内容一条一个事实。更新已有记忆时用相同 key 重新写入即可覆盖。',
    '5. 遗忘：仅当用户明确要求「忘掉/删除」某条记忆时，用 memory_forget。',
    ...keysHint,
  ].join('\n')
}

/**
 * 知识库（KB）激活指令：门控注入——仅当用户确实入库了文档（chunkCount > 0）才调用。
 * 与【长期记忆】并列但**语义边界分离**：KB 是你「已入库的文档/手册/笔记」语料（外部知识），
 * L3 是「用户告诉过你的个人事实/偏好」（关于这个人本身）。两者不混用，避免模型错配：
 * 既不要把 kb_search 当回忆用户偏好，也不要把 memory_retain 当存文档知识。
 * @param chunkCount kb_chunks 主表行数；0 表示空库，调用方应直接返回 '' 不注入。
 */
export function buildKbInstruction(chunkCount: number): string {
  if (chunkCount <= 0) return ''
  return [
    '',
    `【知识库】你已索引 ${chunkCount} 段用户入库文档（向量+词法混合检索）。策略：`,
    '1. 何时取用：回答需要依据「已入库资料（文档/手册/笔记/规范）」的问题时（如「按我们的接口规范怎么写」「公司报销流程是什么」），先调 kb_search 检索相关分块再作答；不要凭记忆编造文档细节。',
    '2. 与长期记忆的边界：kb_search 查「已入库文档」，memory_* 查「用户个人事实」——问资料用 kb_search，问用户本人用 memory_search，两者不要互相替代。',
    '3. 不要调用：闲聊、通用常识、无需文档依据的问题不要调 kb_search。检索返回空时如实告知用户「知识库里没有相关内容」，不要硬凑。',
    '4. 引用来源：作答时尽量点出内容来自哪份文档（kb_search 结果带 title/source），方便用户溯源。',
  ].join('\n')
}

/** Skill RAG 激活指令：只给数量与策略，不列技能清单，避免 prompt 膨胀。 */
export function buildSkillInstruction(skillCount: number): string {
  return [
    '',
    `【可用技能】你当前可按需检索 ${skillCount} 个技能（不列清单）。策略：`,
    '1. 遇到写作、设计、数据处理、自动化、研究方法等明显需要专门技能说明的任务时，先调用 skill_search，用任务关键词检索相关技能。',
    '2. 命中后使用 load_skill 按 id 读取完整说明，再按该技能要求执行；不要只看名字就臆测技能内容。',
    '3. 闲聊、通用问答、简单解释、无需专门流程的任务不要调用。',
    '4. 用户显式 @提及的技能已直接注入当前上下文，无需再 load。',
    '5. 组队节点和编辑器节点可能也看见这些工具，但它们通常已有显式绑定技能，除非现有绑定不足以完成任务，否则不要额外检索。',
  ].join('\n')
}

/** @提及解析结果 */
export interface MentionResolution {
  /** 命中的角色（@角色名）→ 走组队编排 */
  agents: Agent[]
  /** 命中的能力（@能力名）→ 走组队/能力编排 */
  capabilities: Capability[]
  /** 命中的技能（@技能名）→ 注入主 Agent 上下文，不跑编排（铁律22） */
  skills: SkillMeta[]
  /** 剥掉 @提及后的纯文本问题 */
  cleanText: string
}

/**
 * 解析消息文本里的 @提及。
 *
 * 优先级：
 * 1. 芯片显式映射 `explicit`（kind+id，稳定，不依赖展示名）
 * 2. 正文稳定 token：`@[agent|capability|skill:<id>]`（历史/粘贴兼容）
 * 3. 正文 `@名字`（手打 / 新发送的展示形态）：大小写不敏感，同名冲突 角色 > 能力 > 技能
 *
 * 三类语义分流：
 *   - 角色/能力 = 可执行实体（@它 = 让它干活，走 buildTeamGraph 跑编排）
 *   - 技能 = 知识/规范包（@它 = 注入当前对话上下文，不跑编排，铁律22）
 */
export function resolveMentions(
  text: string,
  agents: Agent[],
  capabilities: Capability[],
  skills: SkillMeta[] = [],
  explicit: ExplicitMention[] = [],
): MentionResolution {
  const hitAgents = new Map<string, Agent>()
  const hitCaps = new Map<string, Capability>()
  const hitSkills = new Map<string, SkillMeta>()
  const agentsById = new Map(agents.map((a) => [a.id, a]))
  const capsById = new Map(capabilities.map((c) => [c.id, c]))
  const skillsById = new Map(skills.map((s) => [s.id, s]))
  const lowerAgents = new Map(agents.map((a) => [a.name.toLowerCase(), a]))
  const lowerCaps = new Map(capabilities.map((c) => [c.name.toLowerCase(), c]))
  const lowerSkills = new Map(skills.map((s) => [s.name.toLowerCase(), s]))

  const spans: Array<[number, number]> = []
  const covered = (start: number, end: number): boolean =>
    spans.some(([s, e]) => start < e && end > s)

  const addHit = (kind: MentionKind, id: string): { name: string } | null => {
    if (kind === 'agent') {
      const a = agentsById.get(id)
      if (!a) return null
      hitAgents.set(a.id, a)
      return { name: a.name }
    }
    if (kind === 'capability') {
      const c = capsById.get(id)
      if (!c) return null
      hitCaps.set(c.id, c)
      return { name: c.name }
    }
    const s = skillsById.get(id)
    if (!s) return null
    hitSkills.set(s.id, s)
    return { name: s.name }
  }

  const recordSpan = (kind: MentionKind, id: string, start: number, end: number): void => {
    if (!addHit(kind, id)) return
    spans.push([start, end])
  }

  // 0) 芯片显式映射（展示文本是 @名字，id 走旁路）
  const explicitNames: string[] = []
  for (const em of explicit) {
    const hit = addHit(em.kind, em.id)
    if (hit) explicitNames.push(hit.name)
  }

  // 1) 稳定 token（按 kind+id）
  MENTION_TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MENTION_TOKEN_RE.exec(text)) !== null) {
    recordSpan(m[1] as MentionKind, m[2], m.index, m.index + m[0].length)
  }

  // 2) 显式命中资产的 `@完整名字`（支持名字含点号等 NAME_RE 吃不到的字符）
  //    长名优先，避免短名前缀误剥。
  const namesToStrip = [...new Set(explicitNames)].sort((a, b) => b.length - a.length)
  for (const name of namesToStrip) {
    const needle = `@${name}`
    let from = 0
    while (from < text.length) {
      const i = text.indexOf(needle, from)
      if (i < 0) break
      const end = i + needle.length
      if (!covered(i, end)) spans.push([i, end])
      from = end
    }
  }

  // 3) 展示名 / 手打 @名字（跳过已覆盖区间）
  MENTION_NAME_RE.lastIndex = 0
  while ((m = MENTION_NAME_RE.exec(text)) !== null) {
    const start = m.index
    const end = start + m[0].length
    if (covered(start, end)) continue
    const name = m[1].toLowerCase()
    const agent = lowerAgents.get(name)
    const cap = lowerCaps.get(name)
    const skill = lowerSkills.get(name)
    if (agent) {
      hitAgents.set(agent.id, agent)
      spans.push([start, end])
    } else if (cap) {
      hitCaps.set(cap.id, cap)
      spans.push([start, end])
    } else if (skill) {
      hitSkills.set(skill.id, skill)
      spans.push([start, end])
    }
  }

  spans.sort((a, b) => a[0] - b[0])
  // 合并重叠/相邻重复 span（显式名字与 NAME_RE 可能双记）
  const merged: Array<[number, number]> = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && span[0] < last[1]) {
      last[1] = Math.max(last[1], span[1])
    } else {
      merged.push([...span] as [number, number])
    }
  }

  let cleanText = text
  for (let i = merged.length - 1; i >= 0; i--) {
    const [s, e] = merged[i]
    cleanText = cleanText.slice(0, s) + cleanText.slice(e)
  }
  cleanText = cleanText.replace(/\s{2,}/g, ' ').trim()

  return {
    agents: [...hitAgents.values()],
    capabilities: [...hitCaps.values()],
    skills: [...hitSkills.values()],
    cleanText,
  }
}

// skill <skill> XML 注入已收口到 skills/provider.ts 的 SkillContextProvider（task 7.4 铁律22）

/**
 * 把 role_ids/capability_ids 拼成可执行 WorkflowGraph（§三之三 M 第二阶段）。
 * 规则：
 *   - 单能力 → 直接用该能力的图（原样跑）
 *   - 单角色 → 单 agent 图
 *   - 多角色（无能力）→ groupchat
 *   - 多能力 / 角色+能力 → 外层 sequential：嵌入各能力真实子图，再接角色段
 *     （能力不再降级为 description 伪 agent）
 */
export function buildTeamGraph(
  json: TeamJson,
  resolveAgent: (id: string) => Agent | null,
  resolveCapability: (id: string) => Capability | null,
): WorkflowGraph | null {
  const roleIds = json.role_ids ?? []
  const capIds = json.capability_ids ?? []

  const agents = roleIds
    .map((id) => resolveAgent(id))
    .filter((a): a is Agent => !!a)
  const caps = capIds
    .map((id) => resolveCapability(id))
    .filter((c): c is Capability => !!c)

  // 单能力且无角色 → 直接跑能力图
  if (caps.length === 1 && agents.length === 0) {
    return caps[0].graph
  }

  // 单角色且无能力 → 单 agent 图
  if (agents.length === 1 && caps.length === 0) {
    const a = agents[0]
    return {
      nodes: [agentNodeFromAgent(a, { x: 0, y: 0 })],
      edges: [],
    }
  }

  // 多角色且无能力 → groupchat（保持原语义）
  if (caps.length === 0 && agents.length > 1) {
    const containerId = 'home_team'
    const childNodes = agents.map((a, i) =>
      agentNodeFromAgent(a, { x: 80 + i * 220, y: 120 }, containerId),
    )
    return {
      nodes: [
        {
          id: containerId,
          type: 'groupchat',
          data: {
            label: '临时组队',
            participants: childNodes.map((n) => n.id),
            selector_mode: 'round_robin',
            max_rounds: Math.max(2, agents.length),
          },
          position: { x: 0, y: 0 },
        },
        ...childNodes,
      ],
      edges: [],
    }
  }

  const total = agents.length + caps.length
  if (total === 0) return null

  // 多能力 / 角色+能力：外层 sequential + 能力真子图嵌入
  const mixId = 'home_mix'
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const stageIds: string[] = []

  caps.forEach((c, i) => {
    const embedded = embedCapabilityGraph(c, `cap_${c.id}_`, mixId)
    nodes.push(...embedded.nodes)
    edges.push(...embedded.edges)
    stageIds.push(embedded.rootId)
    void i
  })

  if (agents.length === 1) {
    const a = agents[0]
    nodes.push(agentNodeFromAgent(a, { x: 80 + caps.length * 220, y: 120 }, mixId))
    stageIds.push(a.id)
  } else if (agents.length > 1) {
    const agentsId = 'home_agents'
    const childNodes = agents.map((a, i) =>
      agentNodeFromAgent(a, { x: 80 + i * 220, y: 240 }, agentsId),
    )
    nodes.push(
      {
        id: agentsId,
        type: 'groupchat',
        data: {
          label: '角色协作',
          participants: childNodes.map((n) => n.id),
          selector_mode: 'round_robin',
          max_rounds: Math.max(2, agents.length),
          parentId: mixId,
        },
        position: { x: 80 + caps.length * 220, y: 120 },
      },
      ...childNodes,
    )
    stageIds.push(agentsId)
  }

  if (stageIds.length === 0) return null

  // 阶段间显式边：sequential 边界由 builder.resolveSeqBoundary 改写到真实 executor
  for (let i = 0; i < stageIds.length - 1; i++) {
    edges.push({ source: stageIds[i], target: stageIds[i + 1] })
  }

  nodes.unshift({
    id: mixId,
    type: 'sequential',
    data: {
      label: '临时组队',
      participants: stageIds,
    },
    position: { x: 0, y: 0 },
  })

  return { nodes, edges }
}

/**
 * 把能力图节点/边 id 加前缀嵌入父图，避免与其它能力或角色节点冲突。
 * rootId = 原图入口节点（顶层 isEntry / 拓扑起点）的 remap id，供外层 sequential 挂接。
 */
export function embedCapabilityGraph(
  c: Capability,
  prefix: string,
  parentId: string,
): { nodes: GraphNode[]; edges: GraphEdge[]; rootId: string } {
  const graph = c.graph ?? { nodes: [], edges: [] }
  const idMap = new Map<string, string>()
  for (const n of graph.nodes) {
    idMap.set(n.id, `${prefix}${n.id}`)
  }
  const remap = (id: string): string => idMap.get(id) ?? `${prefix}${id}`

  const nodes: GraphNode[] = graph.nodes.map((n) => {
    const d = { ...(n.data as Record<string, unknown>) }
    const hadParent = typeof d.parentId === 'string' && d.parentId.length > 0
    if (hadParent) {
      d.parentId = remap(String(d.parentId))
    } else {
      d.parentId = parentId
    }
    if (Array.isArray(d.participants)) {
      d.participants = (d.participants as unknown[]).map((p) =>
        typeof p === 'string' ? remap(p) : p,
      )
    }
    if (typeof d.aggregator === 'string') d.aggregator = remap(d.aggregator)
    if (typeof d.output_from === 'string') d.output_from = remap(d.output_from)
    d.sourceCapabilityId = c.id
    d.capabilityLabel = c.name
    if (c.allowedToolNames?.length) d.allowedToolNames = c.allowedToolNames
    return {
      id: remap(n.id),
      type: n.type,
      data: d,
      position: n.position,
    }
  })

  const edges: GraphEdge[] = (graph.edges ?? []).map((e) => ({
    ...e,
    source: remap(e.source),
    target: remap(e.target),
  }))

  // stage 挂接点必须是能力图「顶层」节点（容器或顶层 agent），
  // 不能用 resolveStartExecutor 深挖到的首个 agent——否则外层 sequential
  // 边界边无法经 resolveSeqBoundary 改写到末 participant。
  const originalTops = graph.nodes.filter(
    (n) => !(n.data as { parentId?: string } | undefined)?.parentId,
  )
  const topPick =
    originalTops.find((n) => (n.data as { isEntry?: boolean }).isEntry === true) ??
    originalTops[0]
  let rootId = topPick ? remap(topPick.id) : ''
  if (!rootId && graph.nodes.length > 0) {
    try {
      rootId = remap(resolveStartExecutor(graph))
    } catch {
      rootId = nodes[0]?.id ?? `${prefix}missing`
    }
  }
  if (!rootId) rootId = `${prefix}missing`

  return { nodes, edges, rootId }
}

function agentNodeFromAgent(
  a: Agent,
  position: { x: number; y: number },
  parentId?: string,
): GraphNode {
  return {
    id: a.id,
    type: 'agent',
    data: {
      label: a.name,
      instructions: a.instructions,
      description: a.description,
      skillIds: a.skillIds,
      allowedToolNames: a.allowedToolNames,
      modelId: a.modelId,
      temperature: a.temperature,
      maxTokens: a.maxTokens,
      outputConstraints: a.outputConstraints,
      sourceAgentId: a.id,
      ...(parentId ? { parentId } : {}),
    },
    position,
  }
}

/** 组队执行：拼图 → buildWorkflow → runWorkflow，事件经 onEvent 转 HomeStreamEvent */
export async function runTeam(
  graph: WorkflowGraph,
  inputText: string,
  sessionId: string,
  deps: BuildDeps,
  onEvent: (e: HomeStreamEvent) => void,
  signal?: AbortSignal,
  /** run_events 事实流归属（由 home.chat 入口生成并透传） */
  runId?: string,
): Promise<{ output: string }> {
  const nodeSummary = graph.nodes
    .map((n) => `${n.id}:${n.type}`)
    .join(',')
  logger.info(
    `[trace:cap] runTeam.start session=${sessionId} nodes=[${nodeSummary}] ` +
      `edges=${graph.edges.length} inputLen=${inputText.length}`,
  )
  const t0 = Date.now()
  const wf = buildWorkflow(graph, deps)
  const result = await runWorkflow(
    wf,
    { text: inputText, sessionId, runId },
    (e: StreamEvent) => {
      if (e.type === 'failed' || e.type === 'node_error' || e.type === 'done') {
        logger.info(`[trace:cap] runTeam.event type=${e.type} ${JSON.stringify(e).slice(0, 240)}`)
      }
      onEvent({ type: 'orch_event', event: e })
    },
    signal,
  )
  logger.info(
    `[trace:cap] runTeam.end session=${sessionId} ms=${Date.now() - t0} outputLen=${result.output.length}`,
  )
  return result
}

// 占位导出避免未使用告警（OrchMessage 在未来 context_mode 接入用）
export type { OrchMessage }
