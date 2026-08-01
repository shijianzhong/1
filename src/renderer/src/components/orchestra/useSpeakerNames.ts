import { useCallback, useMemo } from 'react'
import { useAgents, useCapabilities } from '@renderer/api/hooks'

// —— 编排 speaker（executor_id == 节点 id）→ 显示名映射（气泡头部/提问卡显示用）——
// 覆盖三种 id 形态（§铁律20 + P1 修复）：
// - 角色库 id（agt_xxx）：@角色直跳/主Agent组队，node.id == Agent.id
// - 能力库 id（cap_xxx）：能力作 participant，node.id == Capability.id
// - 画布生成 id（agent_xxx）：能力图直接跑/@能力直跳，node.id 是 EditorPage 生成的时间戳 id，
//   库中查不到 → 遍历能力图节点取 data.label（节点显示名）兜底。
// 用 Map O(1) 查找，避免每条消息对 agents/capabilities 线性扫描。
export function useSpeakerNames(): (id: string) => string {
  const agentsQ = useAgents()
  const capabilitiesQ = useCapabilities()

  const speakerNameMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const a of agentsQ.data ?? []) m.set(a.id, a.name)
    for (const c of capabilitiesQ.data ?? []) {
      m.set(c.id, c.name)
      for (const n of c.graph?.nodes ?? []) {
        const label = (n.data as { label?: string } | undefined)?.label
        if (label && !m.has(n.id)) m.set(n.id, label)
      }
    }
    return m
  }, [agentsQ.data, capabilitiesQ.data])

  return useCallback((id: string): string => speakerNameMap.get(id) ?? id, [speakerNameMap])
}
