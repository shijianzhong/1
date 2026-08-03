import type { WorkflowGraph } from '@shared/types'

// —— Capability 图导入重映射（docs/REGISTRY_PLAN.md §3.2 链路三）——
// 纯函数（不碰 electron/存储/网络），vitest 直接覆盖。
// registry slug → 本地 id；快照字段原样保留；modelId 防御性剥离（本地 ModelConfig id 不可移植）。

export interface RemapMaps {
  /** skill slug → 本地 skl_ id */
  skills: Map<string, string>
  /** agent slug → 本地 agt_ id */
  agents: Map<string, string>
}

export interface RemapResult {
  graph: WorkflowGraph
  /** 图里引用了但未能映射（registry 缺失/未安装）的 skill slug，已去重 */
  droppedSkillSlugs: string[]
}

export function remapGraphForImport(
  graph: WorkflowGraph,
  maps: RemapMaps,
  opts: { materializeAgents: boolean },
): RemapResult {
  const dropped: string[] = []
  const nodes = graph.nodes.map((node) => {
    // 容器节点（groupchat 等）data 无 skillIds/sourceAgentId；participants 是节点 id，不动
    if (node.type !== 'agent') return node
    const data = { ...(node.data as Record<string, unknown>) }

    if (Array.isArray(data.skillIds)) {
      const mapped: string[] = []
      for (const raw of data.skillIds as unknown[]) {
        const slug = String(raw)
        const local = maps.skills.get(slug)
        if (local) mapped.push(local)
        else dropped.push(slug)
      }
      // 原本就是 [] 或全部缺映射 → 删除字段（与「未配置」同语义，避免空数组与 undefined 两种形态并存）
      if (mapped.length > 0) data.skillIds = mapped
      else delete data.skillIds
    }

    // sourceAgentId（导出规范）+ agentId（旧字段，防御性兼容）都按 slug 重映射
    for (const key of ['sourceAgentId', 'agentId'] as const) {
      const slug = data[key]
      if (typeof slug !== 'string' || !slug) continue
      if (opts.materializeAgents) {
        const local = maps.agents.get(slug)
        // 依赖未物化（用户取消勾选/依赖缺失）→ 剔除引用，快照自足不阻断导入
        if (local) data[key] = local
        else delete data[key]
      } else {
        delete data[key]
      }
    }

    delete data.modelId
    return { ...node, data }
  })
  return { graph: { ...graph, nodes }, droppedSkillSlugs: [...new Set(dropped)] }
}
