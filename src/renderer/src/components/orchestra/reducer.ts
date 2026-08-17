import type { StreamEvent } from '@shared/types'
import type { ChatMessage, ToolCallInfo, NodeStateInfo } from './types'

// —— 编排流事件 → 消息列表 reducer（纯函数，HomePage/EditorPage 共用）——
// 从 HomePage 原 orch_event 分支原样抽取 + HITL request_info/request_resolved 扩展。
// node_started/node_done/handoff 不产生气泡（画布高亮/日志用）。

/** 入参/返回值摘要：JSON 序列化后截断 200 字符 */
function summarize(value: unknown): string {
  try {
    const json = typeof value === 'string' ? value : JSON.stringify(value)
    if (!json) return ''
    return json.length > 200 ? json.slice(0, 200) + '…' : json
  } catch {
    return String(value).slice(0, 200)
  }
}

/**
 * 按 speaker 查找该发言者的「可追加」流式气泡（断言 1.3 修复）。
 * 旧实现只看 prev[末]，Concurrent 并行流式时 peer A 的后续 delta 到达
 * 末条若是 peer B → last.speaker 不匹配 → else 走 closeStreaming+新建 A 气泡
 * → A 的文本被拆成多个碎片气泡；tool_call 则直接 return prev 丢失。
 *
 * 修法：从末尾往前找最近一个 speaker 匹配 + streaming（或 retrying）+ 非卡片
 * 的 assistant 气泡。并发流式多气泡共存，各 speaker 续写到自己的气泡。
 * 返回 [index, msg] 或 null（未找到 → 调用方新建气泡）。
 */
function findStreamingBubbleForSpeaker(
  prev: ChatMessage[],
  speaker: string | undefined,
): [number, ChatMessage] | null {
  if (!speaker) return null
  for (let i = prev.length - 1; i >= 0; i--) {
    const m = prev[i]
    if (
      m.role === 'assistant' &&
      m.speaker === speaker &&
      !m.draft &&
      !m.askUser &&
      !m.approval &&
      (m.streaming || m.retrying)
    ) {
      return [i, m]
    }
    // 遇到已完成的同 speaker 气泡就停（不跨过它的历史气泡去复活更早的流式态）——
    // 避免误把早先的 streaming 气泡当续写目标。已完成 = 既不 streaming 也不 retrying。
    if (m.role === 'assistant' && m.speaker === speaker && !m.streaming && !m.retrying) {
      return null
    }
  }
  return null
}

/** 编排流事件应用到消息列表，返回新列表 */
export function applyOrchEvent(prev: ChatMessage[], ev: StreamEvent): ChatMessage[] {
  switch (ev.type) {
    case 'output': {
      // 按 speaker 查找可续写的流式气泡（断言 1.3：Concurrent 并行流式多气泡共存）。
      // final 事件替换文本（终端完整输出，去重复增量）；增量累加文本。
      // retrying 态（重试等待中）也算同一气泡——重试后第二轮重放 resume 续写不开新泡
      //（对齐 home 主链路 HomePage.tsx:254 的 last.streaming || last.retrying 语义）。
      const found = findStreamingBubbleForSpeaker(prev, ev.speaker)
      if (found) {
        const [idx, last] = found
        // 重试恢复：剥掉 retrying/retryInfo（等待态结束，回到正常流式）
        const { retrying: _r, retryInfo: _ri, ...rest } = last
        void _r; void _ri
        const text = ev.final ? ev.text : last.text + ev.text
        return [...prev.slice(0, idx), { ...rest, text, streaming: !ev.final }, ...prev.slice(idx + 1)]
      }
      // 该 speaker 尚无流式气泡（首条增量 / final 但无前置增量 / groupchat 容器非流式输出）：
      // 新建气泡。先定格其它仍在流式的气泡（新气泡出现前的纪律）。
      return [
        ...closeStreaming(prev),
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: ev.text,
          streaming: !ev.final,
          speaker: ev.speaker,
          createdAt: Date.now(),
        },
      ]
    }

    case 'thinking': {
      // 编排内 agent 推理过程：追加到该 speaker 的流式气泡的 thinking 字段（不混进正文）。
      // 按 speaker 查气泡（断言 1.3：Concurrent 并行流式多气泡共存）。
      // retrying 态同样 resume 到同一气泡（重试后第二轮思考续写，对齐 home 主链路 :240 语义）。
      const found = findStreamingBubbleForSpeaker(prev, ev.speaker)
      if (found) {
        const [idx, last] = found
        const { retrying: _r, retryInfo: _ri, ...rest } = last
        void _r; void _ri
        return [
          ...prev.slice(0, idx),
          {
            ...rest,
            streaming: true,
            thinking: (last.thinking ?? '') + ev.text,
            thinkingCollapsed: false,
          },
          ...prev.slice(idx + 1),
        ]
      }
      // 尚无该 speaker 的气泡：先建一个只含 thinking 的占位气泡，后续 output 合并
      return [
        ...closeStreaming(prev),
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: '',
          streaming: true,
          speaker: ev.speaker,
          thinking: ev.text,
          thinkingCollapsed: false,
          createdAt: Date.now(),
        },
      ]
    }

    case 'node_error':
    case 'failed': {
      const errText = ev.type === 'node_error' ? `${ev.node_id}: ${ev.error}` : ev.error
      // 更新末条流式气泡的节点状态为 error。注意：node_started/done/error 的 node_id
      // 是子执行器 id，但事件在父/聚合器上下文里发出 → 仍按「末条流式气泡」归属（保留
      // 父气泡跟踪多子节点的既有语义，非按 speaker 查——否则并发聚合器场景断）。
      let updated = prev
      if (ev.type === 'node_error') {
        const last = prev[prev.length - 1]
        if (last?.role === 'assistant' && last.streaming) {
          const nodeStates = last.nodeStates?.map((ns) =>
            ns.nodeId === ev.node_id && ns.status === 'running'
              ? { ...ns, status: 'error' as const, endedAt: Date.now(), error: ev.error }
              : ns,
          )
          updated = [...prev.slice(0, -1), { ...last, nodeStates }]
        }
      }
      return [
        ...updated,
        { id: crypto.randomUUID(), role: 'assistant', text: errText, error: true },
      ]
    }

    case 'request_info': {
      // HITL 提问卡：先定格所有流式气泡，再追加 pending 卡片
      return [
        ...closeStreaming(prev),
        {
          id: ev.request_id,
          role: 'assistant',
          text: '',
          speaker: ev.node_id,
          orbState: 'listening',
          askUser: {
            requestId: ev.request_id,
            nodeId: ev.node_id,
            question: ev.question,
            context: ev.context,
            status: 'pending',
          },
        },
      ]
    }

    case 'request_resolved': {
      // 卡片定格：response 非空 = 用户已作答；空 = 超时/取消失效
      return prev.map((m) =>
        m.askUser?.requestId === ev.request_id && m.askUser.status === 'pending'
          ? {
              ...m,
              askUser: ev.response
                ? { ...m.askUser, status: 'answered' as const, response: ev.response }
                : { ...m.askUser, status: 'expired' as const },
            }
          : m,
      )
    }

    case 'approval_request': {
      // 工具审批卡：先定格所有流式气泡，再追加 pending 审批卡片
      return [
        ...closeStreaming(prev),
        {
          id: ev.request_id,
          role: 'assistant' as const,
          text: '',
          speaker: ev.node_id,
          orbState: 'listening' as const,
          approval: {
            requestId: ev.request_id,
            nodeId: ev.node_id,
            toolName: ev.tool_name,
            args: ev.args,
            status: 'pending' as const,
          },
        },
      ]
    }

    case 'approval_resolved': {
      // 定格：approved / approved_session → approved；denied → denied；空 = 超时/失效
      return prev.map((m) =>
        m.approval?.requestId === ev.request_id && m.approval.status === 'pending'
          ? {
              ...m,
              approval: ev.response === 'approved' || ev.response === 'approved_session'
                ? {
                    ...m.approval,
                    status: 'approved' as const,
                    sessionWide: ev.response === 'approved_session',
                  }
                : ev.response === 'denied'
                  ? { ...m.approval, status: 'denied' as const }
                  : { ...m.approval, status: 'expired' as const },
            }
          : m,
      )
    }

    case 'retry': {
      // LLM 重试（429/5xx/断网）：重试层整段重跑 stream，模型从头生成。
      // 清空该 speaker 已发的 text/thinking 增量，防第二轮重放导致气泡文本翻倍
      //（CODE_AUDIT 断言 1.1：编排链路 patterns/agent.ts 缺 onRetry 桥接，已补）。
      // tool_use delta 在 agent.emitDelta 被丢弃、tool_call 事件只在 post-stream emit，
      // 故 retry 时无 stale tool chip 需清——与 home 主链路 HomePage.tsx:261 语义对齐。
      // reducer 是纯函数无 i18n hook，存 raw retryInfo，MessageItem 渲染时 t('home:retry.waiting')。
      // 按 speaker 查气泡（断言 1.3：Concurrent 并行时 retry 只清自己 speaker 的气泡）。
      const found = findStreamingBubbleForSpeaker(prev, ev.speaker)
      if (found) {
        const [idx, last] = found
        return [
          ...prev.slice(0, idx),
          {
            ...last,
            text: '',
            thinking: undefined,
            streaming: false,
            orbState: 'solving' as const,
            retrying: '1',
            retryInfo: {
              attempt: ev.attempt,
              maxRetries: ev.maxRetries,
              delayMs: ev.delayMs,
              reason: ev.reason,
            },
          },
          ...prev.slice(idx + 1),
        ]
      }
      return prev
    }

    case 'done':
      // 不产生气泡，但定格全部流式态——防御：主进程虽保证 message_stop 全路径配对
      // 发送，done 到达即运行终结，任何事件丢失都不应留下 streaming=true 的泄漏
      return closeStreaming(prev)

    case 'plan_update': {
      // update_plan 计划更新：渲染为 assistant 消息（Markdown 列表，不占正文气泡）
      const lines = (ev.plan ?? []).map((s) => {
        const mark = s.status === 'completed' ? '✅' : s.status === 'in_progress' ? '🔄' : '⬜'
        return `${mark} ${s.step}`
      })
      const text = (ev.explanation ? `${ev.explanation}\n\n` : '') + lines.join('\n')
      return [
        ...closeStreaming(prev),
        {
          id: crypto.randomUUID(),
          role: 'assistant' as const,
          text,
          speaker: ev.node_id,
          streaming: false,
        },
      ]
    }

    case 'tool_call': {
      // 工具调用：在该 speaker 的流式气泡上标记 searching 态 + 追加 ToolCallInfo。
      // 按 speaker 查气泡（断言 1.3：Concurrent 并行时各 peer 的 toolCall 落到自己的气泡，
      // 不再因末条是别的 peer 而丢失）。
      const found = findStreamingBubbleForSpeaker(prev, ev.node_id)
      if (found) {
        const [idx, last] = found
        const toolCall: ToolCallInfo = {
          id: crypto.randomUUID(),
          tool: ev.tool,
          argsSummary: summarize(ev.args),
          status: 'pending',
          timestamp: Date.now(),
        }
        return [
          ...prev.slice(0, idx),
          { ...last, orbState: 'searching' as const, toolCalls: [...(last.toolCalls ?? []), toolCall] },
          ...prev.slice(idx + 1),
        ]
      }
      return prev
    }

    case 'tool_result': {
      // 工具返回：恢复 working 态 + 更新最后一个 pending 的 toolCall 为 done
      const found = findStreamingBubbleForSpeaker(prev, ev.node_id)
      if (found) {
        const [idx, last] = found
        const toolCalls = last.toolCalls?.map((tc, i, arr) =>
          i === arr.length - 1 && tc.status === 'pending'
            ? { ...tc, status: 'done' as const, resultSummary: summarize(ev.result) }
            : tc,
        )
        return [...prev.slice(0, idx), { ...last, orbState: 'working' as const, toolCalls }, ...prev.slice(idx + 1)]
      }
      return prev
    }

    case 'node_started': {
      // 节点启动：在末条流式气泡上追加 NodeStateInfo。node_id 是子执行器 id，
      // 但事件在父/聚合器上下文发出 → 按「末条流式气泡」归属（父气泡跟踪多子节点，
      // 不按 speaker 查——否则并发聚合器场景下子节点 id ≠ 父气泡 speaker 会丢）。
      const last = prev[prev.length - 1]
      if (last?.role === 'assistant' && last.streaming) {
        const nodeState: NodeStateInfo = {
          nodeId: ev.node_id,
          status: 'running',
          startedAt: Date.now(),
        }
        return [
          ...prev.slice(0, -1),
          { ...last, nodeStates: [...(last.nodeStates ?? []), nodeState] },
        ]
      }
      return prev
    }

    case 'node_done': {
      // 节点完成：更新对应节点状态为 done（同 node_started：末条流式气泡归属）
      const last = prev[prev.length - 1]
      if (last?.role === 'assistant' && last.streaming) {
        const nodeStates = last.nodeStates?.map((ns) =>
          ns.nodeId === ev.node_id && ns.status === 'running'
            ? { ...ns, status: 'done' as const, endedAt: Date.now() }
            : ns,
        )
        return [...prev.slice(0, -1), { ...last, nodeStates }]
      }
      return prev
    }

    default:
      // handoff：不产生气泡
      return prev
  }
}

/** 定格所有流式气泡（新气泡出现前 / 回复完成时） */
export function closeStreaming(prev: ChatMessage[]): ChatMessage[] {
  const now = Date.now()
  return prev.map((m) =>
    m.streaming
      ? { ...m, streaming: false, completedAt: m.completedAt ?? now }
      : m,
  )
}
