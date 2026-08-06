import type { StreamEvent } from '@shared/types'
import type { ChatMessage } from './types'

// —— 编排流事件 → 消息列表 reducer（纯函数，HomePage/EditorPage 共用）——
// 从 HomePage 原 orch_event 分支原样抽取 + HITL request_info/request_resolved 扩展。
// node_started/node_done/handoff 不产生气泡（画布高亮/日志用）。

/** 编排流事件应用到消息列表，返回新列表 */
export function applyOrchEvent(prev: ChatMessage[], ev: StreamEvent): ChatMessage[] {
  switch (ev.type) {
    case 'output': {
      const last = prev[prev.length - 1]
      // 同 speaker 的末条流式气泡：final 事件替换文本（终端完整输出，去掉已累加的增量重复），
      // 增量事件累加文本。
      if (last?.role === 'assistant' && last.streaming && !last.draft && !last.askUser && last.speaker === ev.speaker) {
        const text = ev.final ? ev.text : last.text + ev.text
        return [...prev.slice(0, -1), { ...last, text, streaming: !ev.final }]
      }
      // final 事件到达时若末条不是该 speaker 的流式气泡，说明增量未建立气泡（如 groupchat 容器
      // 非流式输出）→ 直接用完整文本新建成形气泡（streaming=false）。
      return [
        ...closeStreaming(prev),
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: ev.text,
          streaming: !ev.final,
          speaker: ev.speaker,
        },
      ]
    }

    case 'node_error':
    case 'failed': {
      const errText = ev.type === 'node_error' ? `${ev.node_id}: ${ev.error}` : ev.error
      return [
        ...prev,
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

    case 'done':
      // 不产生气泡，但定格全部流式态——防御：主进程虽保证 message_stop 全路径配对
      // 发送，done 到达即运行终结，任何事件丢失都不应留下 streaming=true 的泄漏
      return closeStreaming(prev)

    case 'tool_call': {
      // 工具调用：在末条流式气泡上标记 searching 态（扫描经线动画）
      const last = prev[prev.length - 1]
      if (last?.role === 'assistant' && last.streaming) {
        return [...prev.slice(0, -1), { ...last, orbState: 'searching' as const }]
      }
      return prev
    }

    case 'tool_result': {
      // 工具返回：恢复 working 态（工具调用完成后继续处理）
      const last = prev[prev.length - 1]
      if (last?.role === 'assistant' && last.streaming) {
        return [...prev.slice(0, -1), { ...last, orbState: 'working' as const }]
      }
      return prev
    }

    default:
      // node_started / node_done / handoff：不产生气泡
      return prev
  }
}

/** 定格所有流式气泡（新气泡出现前 / 回复完成时） */
export function closeStreaming(prev: ChatMessage[]): ChatMessage[] {
  return prev.map((m) => (m.streaming ? { ...m, streaming: false } : m))
}
