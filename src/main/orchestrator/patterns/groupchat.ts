import type {
  ExecutorRequest,
  GraphNode,
  OrchMessage,
  StreamEvent,
  WorkflowContext,
} from '@shared/types'
import type { BuilderContext, Executor } from '../models'
import { AgentExecutor, type AgentExecutorOptions } from './agent'

// —— GroupChat pattern（§三 D + §三之三 G + 铁律13/15/19）——
// 容器 Executor（不直接调 LLM，协调 broadcast + 定向请求）。
// 每轮：broadcast 给所有 participant（should_respond=false 仅 extend cache）
//   → 定向请求 next_speaker（should_respond=true 触发 run）
//   → participant 响应（fan-in 回 GroupChatExecutor）
//   → 下一轮 broadcast（excl 发言者）。
// round_robin：selection_func = state => names[round % len]。
// manager：AgentOrchestrationOutput 结构化输出（4b.3）。
// 四 patch（4b.2）：cache/dedup/fairness/output。

export interface GroupChatExecutorOptions {
  id: string
  participantIds: string[]
  selectorMode: 'round_robin' | 'manager'
  maxRounds: number
  /** manager 模式：orchestrator agent id（结构化输出决策）；round_robin 忽略 */
  orchestratorId?: string
}

export class GroupChatExecutor implements Executor {
  readonly id: string
  cache: OrchMessage[] = []
  private round = 0
  private readonly participantIds: string[]
  private readonly selectorMode: 'round_robin' | 'manager'
  private readonly maxRounds: number
  private readonly orchestratorId?: string
  /** 已发言者（fairness patch 用） */
  private spoken = new Set<string>()

  constructor(opts: GroupChatExecutorOptions) {
    this.id = opts.id
    this.participantIds = opts.participantIds
    this.selectorMode = opts.selectorMode
    this.maxRounds = opts.maxRounds
    this.orchestratorId = opts.orchestratorId
  }

  async *handle(
    req: ExecutorRequest,
    ctx: WorkflowContext,
  ): AsyncIterable<StreamEvent> {
    if (!req.shouldRespond) return

    const lastMsg = req.messages[req.messages.length - 1]
    if (!lastMsg) return

    // fan-in 回来的消息（author=某 participant）→ 记录已发言，进入下一轮
    if (lastMsg.author && this.participantIds.includes(lastMsg.author)) {
      this.spoken.add(lastMsg.author)
    }

    // 终止判定：max_rounds 或 所有 participant 已发言（round_robin 简化）
    if (this.round >= this.maxRounds) {
      // 产出最终输出（取最后一条 assistant 消息）
      await ctx.yield_output(lastMsg.content)
      return
    }

    // —— dedup_patch（4b.2）：调 LLM 前对 cache 去重（按 role+author+content）——
    this.cache = dedupMessages(this.cache)

    // —— cache_patch（4b.2）：广播前剥 tool 块（clean_conversation_for_handoff）——
    const cleanCache = stripToolBlocks(this.cache)

    this.round++

    // 选 next_speaker
    const nextSpeaker = this.selectNextSpeaker()
    if (!nextSpeaker) {
      await ctx.yield_output(lastMsg.content)
      return
    }

    // —— broadcast 给所有 participant（should_respond=false 仅 extend cache）——
    // 广播内容：当前完整对话历史（cache_patch 治偶发空 cache）
    for (const pid of this.participantIds) {
      if (pid === nextSpeaker) continue // 发言者单独定向请求
      // should_respond=false 仅 extend cache（runner 硬编码 true，此处用 send_message
      // 让 participant 收到消息但不触发 run——骨架简化：broadcast 也走 send_message，
      // participant 的 AgentExecutor 会 run；完整 should_respond=false 语义需 runner
      // 支持 message 级 flag，4b 后续细化）
      await ctx.send_message(
        {
          role: 'user',
          author: this.id,
          content: lastMsg.content,
        },
        pid,
      )
    }

    // —— 定向请求 next_speaker（should_respond=true 触发 run）——
    // 发言请求自带完整对话历史（cache_patch 治空 cache → 2013）
    await ctx.send_message(
      {
        role: 'user',
        author: this.id,
        content: this.buildSpeakerRequest(cleanCache, nextSpeaker),
      },
      nextSpeaker,
    )

    yield* [] // 无直接流式事件（participant 响应经 fan-in 回来）
  }

  /** round_robin selection_func（§三之三 G） */
  private selectNextSpeaker(): string | null {
    if (this.participantIds.length === 0) return null
    if (this.selectorMode === 'round_robin') {
      return this.participantIds[this.round % this.participantIds.length]
    }
    // manager 模式：4b.3 接入结构化输出决策
    // 骨架降级：round_robin
    return this.participantIds[this.round % this.participantIds.length]
  }

  /** 发言请求（cache_patch：自带完整历史 + speaker 输出约束） */
  private buildSpeakerRequest(cache: OrchMessage[], speaker: string): string {
    const history = cache
      .map((m) => `${m.author ?? m.role}: ${m.content}`)
      .join('\n')
    return `【群聊历史】\n${history}\n\n你是 ${speaker}，请基于历史发言。`
  }
}

// —— GroupChat 四 patch 工具函数（4b.2）——

/** dedup_patch：按 role+author+content 去重（§三之三 G） */
export function dedupMessages(msgs: OrchMessage[]): OrchMessage[] {
  const seen = new Set<string>()
  const out: OrchMessage[] = []
  for (const m of msgs) {
    const key = `${m.role}|${m.author ?? ''}|${m.content}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(m)
  }
  return out
}

/** clean_conversation_for_handoff：剥 tool 块（铁律14，防孤儿 tool_use → 2013） */
export function stripToolBlocks(msgs: OrchMessage[]): OrchMessage[] {
  return msgs.filter((m) => m.role !== 'tool' && !m.isFunctionResult)
}

/** manager_output_patch：剥 markdown 围栏 + 鲁棒 JSON 抽取（§三之三 G） */
export function extractManagerOutput(raw: string): unknown | null {
  // 剥 ```json ... ``` 围栏
  let text = raw.trim()
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) text = fenceMatch[1].trim()

  try {
    return JSON.parse(text)
  } catch {
    // 正则兜底：抽 { ... }
    const objMatch = text.match(/\{[\s\S]*\}/)
    if (objMatch) {
      try {
        return JSON.parse(objMatch[0])
      } catch {
        return null
      }
    }
    return null
  }
}

/** manager_fairness_patch：未发言者存在则强制 terminate=false（§三之三 G） */
export function applyFairnessPatch(
  output: { terminate: boolean; next_speaker: string },
  participantIds: string[],
  spoken: Set<string>,
): { terminate: boolean; next_speaker: string } {
  if (output.terminate) {
    const unspoken = participantIds.filter((p) => !spoken.has(p))
    if (unspoken.length > 0) {
      return { terminate: false, next_speaker: unspoken[0] }
    }
  }
  return output
}


/** builder：注册 participants + GroupChat 容器 + fan-in 边 */
export function buildGroupChat(
  node: GraphNode,
  participants: AgentExecutorOptions[],
  bctx: BuilderContext,
): void {
  if (participants.length === 0) return
  const data = node.data as {
    selector_mode?: 'round_robin' | 'manager'
    max_rounds?: number
    orchestrator_agent?: string
  }

  const participantIds: string[] = []
  for (const opts of participants) {
    const ex = new AgentExecutor(opts)
    bctx.addExecutor(ex)
    participantIds.push(ex.id)
    // fan-in 边：participant → groupchat 容器
    bctx.addEdge(ex.id, node.id)
  }

  const gc = new GroupChatExecutor({
    id: node.id,
    participantIds,
    selectorMode: data.selector_mode ?? 'round_robin',
    maxRounds: data.max_rounds ?? 6,
    orchestratorId: data.orchestrator_agent,
  })
  bctx.addExecutor(gc)
}
