import { useMemo } from 'react'
import { ReactFlow, Background, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { WorkflowGraph } from '@shared/types'

// —— 能力编排图只读缩略预览（所见即所得，禁交互）——
// 独立成文件是为了让 CreateConfirmCard 能 lazy 引入：@xyflow/react + d3 约 360KB，
// 只在聊天里真出现「能力创建确认卡」时才加载，不进冷启动首包。
export function GraphPreview({ graph }: { graph: WorkflowGraph }) {
  const { rfNodes, rfEdges } = useMemo(() => {
    const ns: Node[] = graph.nodes.map((n) => ({
      id: n.id,
      position: n.position,
      data: { label: (n.data as { label?: string }).label ?? n.id },
      draggable: false,
    }))
    const es: Edge[] = graph.edges.map((e, i) => ({
      id: `e${i}`,
      source: e.source,
      target: e.target,
      label: e.condition,
    }))
    return { rfNodes: ns, rfEdges: es }
  }, [graph])

  return (
    <div className="create-card__graph">
      <ReactFlow nodes={rfNodes} edges={rfEdges} fitView nodesDraggable={false} nodesConnectable={false}
        elementsSelectable={false} zoomOnScroll={false} panOnDrag={false} proOptions={{ hideAttribution: true }}>
        <Background gap={16} />
      </ReactFlow>
    </div>
  )
}
