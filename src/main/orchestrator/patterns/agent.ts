import type {
  AgentRunCallbacks,
  ExecutorRequest,
  LlmMessage,
  StreamEvent,
  WorkflowContext,
} from '@shared/types'
import type { Executor } from '../models'
import { Agent } from '../agent'
import type { AgentConfig } from '@shared/types'
import type { LLMClientOptions } from '../../llm/client'

// —— Agent 叶子 Executor（§三 D + §三之三 G Sequential）——
// handle 接收消息 → 组装 LlmMessage（strip_tool_blocks_filter 治 2013，
// wake_on_upstream 治复述）→ Agent.run → emit output 事件 → yield_output。
// executor_id == agent name（铁律20）。

export interface AgentExecutorOptions {
  config: AgentConfig
  llmOpts: LLMClientOptions
  toolCtx?: { sessionId?: string; signal?: AbortSignal }
  /** 可选注入 Agent（测试用 mock）；不传则内部 new Agent */
  agent?: Agent
}

export class AgentExecutor implements Executor {
  readonly id: string
  cache: import('@shared/types').OrchMessage[] = []
  private readonly agent: Agent

  constructor(opts: AgentExecutorOptions) {
    this.id = opts.config.name
    this.agent = opts.agent ?? new Agent(opts.config, {
      llmOpts: opts.llmOpts,
      toolCtx: opts.toolCtx,
    })
  }

  async *handle(
    req: ExecutorRequest,
    ctx: WorkflowContext,
  ): AsyncIterable<StreamEvent> {
    if (!req.shouldRespond) {
      // should_respond=false：仅 extend cache（broadcast 模式），不 run
      return
    }

    // 组装 LlmMessage（cache → messages）
    const messages = this.assembleMessages(ctx)

    const callbacks: AgentRunCallbacks = {
      onText: (text) => {
        // text delta 通过 output 事件流式推前端（speaker=executor_id）
        void ctx.add_event({
          type: 'output',
          node_id: this.id,
          speaker: this.id,
          text,
        })
      },
      // thinking delta 不转发：编排场景 orch_event 流只有 output（正文）一类，
      // 若把 thinking 混进 output 会被前端当正文渲染，且与 finalText（仅 text block）不一致。
      // 主页单聊的 thinking 走独立 {type:'thinking'} 事件；编排内 thinking 暂不透传（MVP）。
      onThinking: () => {},
    }

    const result = await this.agent.run(
      { messages, signal: this.agent.deps.toolCtx?.signal },
      callbacks,
    )

    // 把产出追加到 cache（供下游 fan-out）
    this.cache.push({
      role: 'assistant',
      author: this.id,
      content: result.finalText,
    })

    // terminal 输出
    await ctx.yield_output(result.finalText)
  }

  /**
   * 组装 messages：cache 里的 OrchMessage → LlmMessage。
   * strip_tool_blocks_filter（§G Sequential）：下游无 tool 时剥上游 tool 块治 2013。
   * wake_on_upstream（§G）：末条 assistant 且 author≠self 时追加 user 唤醒指令治复述。
   */
  private assembleMessages(ctx: WorkflowContext): LlmMessage[] {
    const messages: LlmMessage[] = []
    for (const m of this.cache) {
      // tool 块过滤（骨架简化：tool_result 角色跳过，防 2013）
      if (m.role === 'tool' || m.isFunctionResult) continue
      messages.push({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })
    }

    // wake_on_upstream：末条 assistant 且 author≠self → 追加 user 唤醒（§G）
    const last = messages[messages.length - 1]
    if (last?.role === 'assistant') {
      const lastCache = this.cache[this.cache.length - 1]
      if (lastCache?.author && lastCache.author !== this.id) {
        messages.push({
          role: 'user',
          content: '请基于上游信息继续，输出你的部分。',
        })
      }
    }

    void ctx // 预留：未来 context_filter 自定义过滤
    return messages
  }
}
