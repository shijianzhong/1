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
import { logger } from '../../logger'
import { repairToolPairs, stripToolBlocksFilter } from '../constraints'

// —— Agent 叶子 Executor（§三 D + §三之三 G Sequential）——
// handle 接收消息 → 组装 LlmMessage（Task 8b 条件化保 tool 块 / strip 无 tool 下游，
// wake_on_upstream 治复述）→ Agent.run → emit output 事件 → yield_output。
// executor_id == agent name（铁律20）。

export interface AgentExecutorOptions {
  config: AgentConfig
  llmOpts: LLMClientOptions
  toolCtx?: Agent['deps']['toolCtx']
  /** 可选注入 Agent（测试用 mock）；不传则内部 new Agent */
  agent?: Agent
}

export class AgentExecutor implements Executor {
  readonly id: string
  cache: import('@shared/types').OrchMessage[] = []
  cacheTokens = 0
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
      // Task 9：编排模式保留 thinking，转发到事件流（独立 thinking 事件，前端按 type 分流渲染）
      onThinking: (text) => {
        void ctx.add_event({
          type: 'thinking',
          node_id: this.id,
          speaker: this.id,
          text,
        })
      },
      // Task 8a + C1：把 tool 轨迹写入 cache（供下游 fan-out 看到上游工具调用）
      // C1 修复：存 name + input，assembleMessages 据此重建真 tool_use block（治孤儿 tool_result）
      onToolCall: (tool, args, toolUseId) => {
        this.cache.push({
          role: 'assistant',
          author: this.id,
          content: `[tool:${tool}]`,   // 占位文本保留（无-tools 下游降级时用）
          toolUseId,
          toolUseName: tool,            // C1：供 assembleMessages 重建真 tool_use block
          toolUseInput: args,           // C1：同上
        })
      },
      onToolResult: (tool, result, toolUseId) => {
        this.cache.push({
          role: 'user',
          author: this.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
          toolUseId,
          isFunctionResult: true,
        })
      },
    }

    logger.info(
      `[trace:cap] AgentExecutor.run id=${this.id} msgs=${messages.length} cache=${this.cache.length}`,
    )
    const result = await this.agent.run(
      { messages, signal: this.agent.deps.toolCtx?.signal },
      callbacks,
    )
    logger.info(
      `[trace:cap] AgentExecutor.done id=${this.id} hitIterLimit=${result.hitIterationLimit} ` +
        `finalTextLen=${result.finalText.length}`,
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
   * 组装 messages：cache OrchMessage → LlmMessage。
   * Task 8b（铁律16-18 条件化）：本 agent 有 tools → repairToolPairs 保留 tool 块配对；
   * 无 tools → stripToolBlocksFilter 剥上游 tool 块（治 Anthropic 2013）。
   * wake_on_upstream（§G）：末条 assistant 且 author≠self 时追加 user 唤醒指令治复述。
   */
  private assembleMessages(ctx: WorkflowContext): LlmMessage[] {
    const hasTools =
      (this.agent.config.tools?.length ?? 0) > 0 ||
      (this.agent.config.toolNames?.length ?? 0) > 0
    let source = [...this.cache]
    source = hasTools ? repairToolPairs(source) : stripToolBlocksFilter(source)

    const messages: LlmMessage[] = []
    for (const m of source) {
      const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user'
      let content: LlmMessage['content']
      if (hasTools && m.isFunctionResult) {
        // tool_result → 真 block（配对用 tool_use_id）
        content = [{ type: 'tool_result', tool_use_id: m.toolUseId ?? '', content: m.content }]
      } else if (hasTools && m.toolUseId && m.toolUseName) {
        // C1 修复：tool_use 占位 → 重建真 tool_use block（配对完整，不再孤儿）
        // 注意：repairToolPairs 已在此循环之前调用，孤儿 tool_use（无配对 result）
        // 已被降级为纯文本（删 toolUseId），不会进入此分支——只有配对完整的才重建
        content = [{ type: 'tool_use', id: m.toolUseId, name: m.toolUseName, input: m.toolUseInput ?? {} }]
      } else {
        content = m.content
      }
      // full_conversation extend 后 cache 会有连续同角色（原始 user + 多跳 assistant），
      // Anthropic 要求 user/assistant 严格交替 → 连续同角色合并为一条（防 400）
      const last = messages[messages.length - 1]
      if (last && last.role === role) {
        if (typeof last.content === 'string' && typeof content === 'string') {
          last.content = `${last.content}\n\n${content}`
        } else {
          const lastBlocks = typeof last.content === 'string'
            ? [{ type: 'text' as const, text: last.content }]
            : (last.content as unknown[])
          const curBlocks = typeof content === 'string'
            ? [{ type: 'text' as const, text: content }]
            : (content as unknown[])
          last.content = [...lastBlocks, ...curBlocks] as LlmMessage['content']
        }
      } else {
        messages.push({ role, content })
      }
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
