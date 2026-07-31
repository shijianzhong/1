import type {
  Agent,
  Capability,
  GraphNode,
  HomeStreamEvent,
  OrchMessage,
  Persona,
  Skill,
  StreamEvent,
  WorkflowGraph,
} from '@shared/types'
import { buildWorkflow, type BuildDeps } from './builder'
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
  ].join('\n')
}

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
    '3. propose_* 只生成预览卡片，不会直接入库。调用后请告诉用户"已生成预览，请在下方卡片中确认或修改后入库"。',
    '4. 能力编排图 graph 约定：nodes 为 agent 节点（data 含 label + instructions，或引用已有角色）与编排容器节点（sequential/concurrent/groupchat/handoff，容器 data 含 participantIds 等）；edges 描述连线。必须产出结构合法的 graph。',
    '5. 人设修改：propose_persona 的 instructions 是完整的新人设正文（全量替换）。改人设时必须基于【当前人设原文】修改，产出完整版，而非"增加以下内容"之类的片段。只改称呼/角色/语种时 instructions 不传，只带 alias/role/preferredLanguage——系统会自动保留人设原文，无需回传。',
    '6. 用户在卡片上可修改字段；用户确认后系统会自动入库，你无需重复调用。',
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
    '2. 何时记录：当用户在对话中透露跨会话仍有价值的稳定信息时，主动调 memory_retain 记下。值得记的：稳定偏好（如「喜欢晨跑」「不吃辣」）、身份信息（职业/称呼/所在地）、项目约定（技术栈/代码规范/部署方式）、长期目标。',
    '3. 不要记：一次性请求、临时状态、易变信息（「今天很累」）、仅当前会话相关的上下文、以及你已经记住的内容（重复记忆前先 memory_search 确认）。',
    '4. 记录方式：memory_retain 需指定 category（preference 偏好 / identity 身份 / project 项目约定 / goal 目标 / fact 其它），内容一条一个事实。更新已有记忆时用相同 key 重新写入即可覆盖。',
    '5. 遗忘：仅当用户明确要求「忘掉/删除」某条记忆时，用 memory_forget。',
    ...keysHint,
  ].join('\n')
}

/** @提及解析结果 */
export interface MentionResolution {
  /** 命中的角色（@角色名）→ 走组队编排 */
  agents: Agent[]
  /** 命中的能力（@能力名）→ 走组队/能力编排 */
  capabilities: Capability[]
  /** 命中的技能（@技能名）→ 注入主 Agent 上下文，不跑编排（铁律22） */
  skills: Skill[]
  /** 剥掉 @提及后的纯文本问题 */
  cleanText: string
}

/**
 * 解析消息文本里的 @提及（@角色名 / @能力名 / @技能名）。
 * 匹配规则：@后跟名字，名字到下一个空白/标点/@ 结束；按名字精确命中
 * （大小写不敏感），未命中视为普通文本保留。
 *
 * 三类语义分流：
 *   - 角色/能力 = 可执行实体（@它 = 让它干活，走 buildTeamGraph 跑编排）
 *   - 技能 = 知识/规范包（@它 = 注入当前对话上下文，不跑编排，铁律22）
 * 同名冲突时优先级：角色 > 能力 > 技能（角色是最具体的可执行体）。
 */
export function resolveMentions(
  text: string,
  agents: Agent[],
  capabilities: Capability[],
  skills: Skill[] = [],
): MentionResolution {
  const hitAgents = new Map<string, Agent>()
  const hitCaps = new Map<string, Capability>()
  const hitSkills = new Map<string, Skill>()
  const lowerAgents = new Map(agents.map((a) => [a.name.toLowerCase(), a]))
  const lowerCaps = new Map(capabilities.map((c) => [c.name.toLowerCase(), c]))
  const lowerSkills = new Map(skills.map((s) => [s.name.toLowerCase(), s]))

  // @名字：名字到空白/常见标点/@ 结束（允许中文、字母、数字、_、-）
  const mentionRe = /@([\w\u4e00-\u9fa5-]+)/g
  let m: RegExpExecArray | null
  const spans: Array<[number, number]> = []
  while ((m = mentionRe.exec(text)) !== null) {
    const name = m[1].toLowerCase()
    const agent = lowerAgents.get(name)
    const cap = lowerCaps.get(name)
    const skill = lowerSkills.get(name)
    if (agent) {
      hitAgents.set(agent.id, agent)
      spans.push([m.index, m.index + m[0].length])
    } else if (cap) {
      hitCaps.set(cap.id, cap)
      spans.push([m.index, m.index + m[0].length])
    } else if (skill) {
      hitSkills.set(skill.id, skill)
      spans.push([m.index, m.index + m[0].length])
    }
    // 未命中：不当提及，保留原文
  }

  // 剥掉命中提及后的纯文本（折叠多余空白）
  let cleanText = text
  for (let i = spans.length - 1; i >= 0; i--) {
    const [s, e] = spans[i]
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

/**
 * 把 @技能 inline 成 <skill> XML 块（铁律22，限长 24000 字）。
 * 与 persona 绑定 skill 的注入逻辑一致；此处供 @skill 动态注入当前对话。
 */
export function buildSkillBlocks(skills: Skill[]): string[] {
  const blocks: string[] = []
  for (const skill of skills) {
    const content =
      skill.content.length > 24000
        ? skill.content.slice(0, 24000) + '\n\n[... skill 内容超长截断 ...]'
        : skill.content
    const desc = skill.description ? `\n  description: ${skill.description}` : ''
    blocks.push(`<skill name="${skill.name}"${desc}>\n${content}\n</skill>`)
  }
  return blocks
}

/**
 * 把 role_ids/capability_ids 拼成可执行 WorkflowGraph（§三之三 M 第二阶段）。
 * 规则：
 *   - 单能力 → 直接用该能力的图（原样跑）
 *   - 单角色 → 单 agent 图
 *   - 多角色 → groupchat 图（容器 + 各 agent 子节点）
 *   - 角色+能力 → sequential：先跑能力图（作为前置），再进角色 groupchat
 *     —— MVP 简化为「能力在前作 sequential 第一段」不可行（能力本身是子图），
 *     故 MVP：多目标统一进 groupchat，能力节点作为 participant 之一
 *     （能力图被 .as_agent 化的概念在 MVP 用「能力 description 作 instructions」近似）。
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

  // 多目标 → groupchat：角色作 participant；能力近似为 participant
  // （用 capability description 包一个 agent 节点，MVP 近似 .as_agent）
  const total = agents.length + caps.length
  if (total === 0) return null

  const containerId = 'home_team'
  const childNodes: GraphNode[] = []
  agents.forEach((a, i) => {
    childNodes.push(agentNodeFromAgent(a, { x: 80 + i * 220, y: 120 }, containerId))
  })
  caps.forEach((c, i) => {
    childNodes.push(agentNodeFromCapability(c, { x: 80 + (agents.length + i) * 220, y: 120 }, containerId))
  })

  const container: GraphNode = {
    id: containerId,
    type: 'groupchat',
    data: {
      label: '临时组队',
      participants: childNodes.map((n) => n.id),
      selector_mode: 'round_robin',
      max_rounds: Math.max(2, total), // 至少每人一轮
    },
    position: { x: 0, y: 0 },
  }

  return {
    nodes: [container, ...childNodes],
    edges: [],
  }
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

/** 能力近似为 agent 节点（MVP .as_agent 近似：description+名称作 instructions） */
function agentNodeFromCapability(
  c: Capability,
  position: { x: number; y: number },
  parentId?: string,
): GraphNode {
  return {
    id: c.id,
    type: 'agent',
    data: {
      label: c.name,
      instructions: `你是能力「${c.name}」的执行代理。能力说明：${c.description ?? '见编排图'}。请基于你的理解完成用户交给该能力的任务。`,
      description: c.description,
      sourceCapabilityId: c.id,
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
): Promise<{ output: string }> {
  const wf = buildWorkflow(graph, deps)
  const result = await runWorkflow(
    wf,
    { text: inputText, sessionId },
    (e: StreamEvent) => onEvent({ type: 'orch_event', event: e }),
    signal,
  )
  return result
}

// 占位导出避免未使用告警（OrchMessage 在未来 context_mode 接入用）
export type { OrchMessage }
