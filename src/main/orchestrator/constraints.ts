import type { OrchMessage } from '@shared/types'

// —— 编排约束工具（§K#1 铁律18 + §三之三 G）——
// repair_tool_pairs：扫 call_id 配对修复孤儿 tool_use，防 Anthropic 2013。
//   广播丢"纯 function_result 无 text 的 user 消息"会导致上一 assistant 的
//   function_call 失配对 → 2013。此谓词扫所有 toolUseId 配对，孤儿 tool_use
//   转成普通 assistant 文本（保证后续消息能过 Anthropic 校验）。
//
// strip_tool_blocks_filter：下游无 tool 时剥上游 tool 块（§G Sequential）。

/**
 * 扫 call_id 配对修复孤儿 tool_use（铁律18）。
 * 策略：
 *   - assistant 消息带 toolUseId（tool_use）→ 要求后续有配对的 tool_result
 *     （user 消息 isFunctionResult=true 且 toolUseId 相同）。
 *   - 无配对 → 把该 assistant 降级为纯文本（删 toolUseId，保 content），
 *     让 Anthropic 不再校验配对。
 *   - 孤儿 tool_result（无对应 tool_use）→ 剥 isFunctionResult/toolUseId，
 *     降级为普通 user 消息。
 */
export function repairToolPairs(messages: OrchMessage[]): OrchMessage[] {
  // 收集所有 tool_use id（assistant 带 toolUseId）和 tool_result id（user isFunctionResult）
  const toolUseIds = new Set<string>()
  const toolResultIds = new Set<string>()
  for (const m of messages) {
    if (!m.toolUseId) continue
    if (m.isFunctionResult) {
      toolResultIds.add(m.toolUseId)
    } else {
      toolUseIds.add(m.toolUseId)
    }
  }

  return messages.map((m) => {
    if (!m.toolUseId) return m
    // 孤儿 tool_use（assistant 的 call 没有配对 result）→ 降级为纯文本
    if (!m.isFunctionResult && !toolResultIds.has(m.toolUseId)) {
      const { toolUseId: _drop, ...rest } = m
      // 降级后 content 为空会产生空 text 块——Anthropic 同样拒绝（"text content
      // blocks must be non-empty"），刚治好 2013 又触发新校验错。占位文本兜底。
      if (!rest.content?.trim()) rest.content = '[工具调用]'
      return rest
    }
    // 孤儿 tool_result（user 的 result 没有配对 call）→ 降级为普通 user
    if (m.isFunctionResult && !toolUseIds.has(m.toolUseId)) {
      const { toolUseId: _drop, isFunctionResult: _drop2, ...rest } = m
      if (!rest.content?.trim()) rest.content = '[工具结果]'
      return rest
    }
    return m
  })
}

/**
 * 下游无 tool 时剥上游 tool 块（§G Sequential context_filter）。
 * 用于 Sequential 下游无 tool 的 agent：把 role==='tool' 和 isFunctionResult 的消息剥掉，
 * 防上游 tool_use/tool_result 块流到下游导致 2013。
 */
export function stripToolBlocksFilter(messages: OrchMessage[]): OrchMessage[] {
  return messages.filter((m) => m.role !== 'tool' && !m.isFunctionResult)
}

/**
 * 剥非本 agent 的上游 tool 块（铁律16 精神，用 author 字段而非未落地的 context_mode）。
 * Sequential 有工具的下游收到上游 full_conversation 转发——上游 tool_use/tool_result
 * 属于别的 agent 命名空间，对当前 agent 永远是孤儿（tools 定义里没有那些 tool_use）。
 * 重建为真 block 发出 → Anthropic 2013。剥掉降级为文本（保语义：上游工具调用的
 * 结果内容对下游仍是有效上下文），只留本 agent 自己的 tool 块给 repairToolPairs 配对。
 */
export function stripForeignToolBlocks(messages: OrchMessage[], selfId: string): OrchMessage[] {
  return messages.map((m) => {
    const isToolBlock =
      m.role === 'tool' || m.isFunctionResult || (!!m.toolUseId && !!m.toolUseName)
    if (!isToolBlock) return m
    // 本 agent 自有 tool 块保留：author 显式等于 selfId，或 author 缺失（保守不误剥）。
    // 上游转发消息一定带 author（runner.ts:404-406 + toOrchMessage 保 author），
    // 故 author 明确不等于 selfId 才是上游块。
    if (!m.author || m.author === selfId) return m
    // 上游 tool 块降级为普通文本（保 content 语义）
    const { toolUseId: _d1, toolUseName: _d2, toolUseInput: _d3, isFunctionResult: _d4, ...rest } = m
    rest.role = m.role === 'assistant' ? 'assistant' : 'user'
    // content 为空兜底（防空 text 块触发 Anthropic 校验错，同 repairToolPairs 范式）
    if (!rest.content?.trim()) {
      rest.content = m.isFunctionResult ? '[上游工具结果]' : '[上游工具调用]'
    }
    return rest
  })
}
