import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  Background,
  Controls,
  type Connection,
  type Edge,
  type Node,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Bot, Boxes, Cable, GitBranch, Users, Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { unwrap } from '@renderer/api/client'
import { useCapability, useSaveCapability } from '@renderer/api/hooks'
import { Button } from '@renderer/components/ui/Button'
import { Badge } from '@renderer/components/ui/Badge'
import type { Capability, NodeType, StreamEvent, WorkflowGraph } from '@shared/types'

// —— 能力编排画布（§2 + §5.4）——
// 6 类节点视觉 + 拖拽建图 + 运行态高亮（接 orchestrate:run/onStream）。

const NODE_TYPES: Array<{ type: NodeType; label: string; icon: typeof Bot }> = [
  { type: 'agent', label: 'Agent', icon: Bot },
  { type: 'sequential', label: 'Sequential', icon: GitBranch },
  { type: 'concurrent', label: 'Concurrent', icon: Boxes },
  { type: 'groupchat', label: 'GroupChat', icon: Users },
  { type: 'handoff', label: 'Handoff', icon: Cable },
  { type: 'magentic', label: 'Magentic', icon: Wrench },
]

function nodeColor(type: NodeType): string {
  return 'var(--color-brand-500)'
}

export function EditorPage() {
  return (
    <ReactFlowProvider>
      <EditorCanvas />
    </ReactFlowProvider>
  )
}

function EditorCanvas() {
  const { t } = useTranslation(['editor', 'common'])
  const { capabilityId } = useParams<{ capabilityId: string }>()
  const capQ = useCapability(capabilityId)
  const saveCap = useSaveCapability()
  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [running, setRunning] = useState(false)
  const [activeNode, setActiveNode] = useState<string | null>(null)
  const [output, setOutput] = useState('')

  // 加载已有能力图
  useEffect(() => {
    const cap = capQ.data as Capability | undefined
    if (!cap?.graph) return
    setNodes(
      cap.graph.nodes.map((n) => ({
        id: n.id,
        type: 'default',
        position: n.position,
        data: { kind: n.type, ...n.data, label: n.id },
      })),
    )
    setEdges(
      cap.graph.edges.map((e) => ({
        id: `${e.source}-${e.target}`,
        source: e.source,
        target: e.target,
        animated: false,
        data: { condition: e.condition } as Record<string, unknown>,
      })),
    )
  }, [capQ.data])

  // debounce 存图（节点/边变化后 800ms 落盘）
  useEffect(() => {
    if (!capabilityId || nodes.length === 0 && edges.length === 0) return
    const timer = setTimeout(() => {
      const graph: WorkflowGraph = {
        nodes: nodes.map((n) => ({
          id: n.id,
          type: (n.data as { kind: NodeType }).kind ?? 'agent',
          data: n.data as Record<string, unknown>,
          position: n.position,
        })),
        edges: edges.map((e) => ({
          source: e.source,
          target: e.target,
          condition: (e.data as { condition?: string })?.condition,
        })),
      }
      const cap = capQ.data as Capability | undefined
      void saveCap.mutateAsync({
        id: capabilityId,
        name: cap?.name ?? '未命名',
        description: cap?.description,
        graph,
      })
    }, 800)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, capabilityId])

  const onNodesChange = useCallback(
    (changes: Parameters<typeof applyNodeChanges>[0]) =>
      setNodes((nds) => applyNodeChanges(changes, nds)),
    [],
  )
  const onEdgesChange = useCallback(
    (changes: Parameters<typeof applyEdgeChanges>[0]) =>
      setEdges((eds) => applyEdgeChanges(changes, eds)),
    [],
  )
  const onConnect = useCallback((connection: Connection) => {
    setEdges((eds) => addEdge({ ...connection, animated: false }, eds))
  }, [])

  // 从 palette 拖入新节点
  const onDragStart = (e: React.DragEvent, type: NodeType): void => {
    e.dataTransfer.setData('application/reactflow', type)
    e.dataTransfer.effectAllowed = 'move'
  }
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const type = e.dataTransfer.getData('application/reactflow') as NodeType
      if (!type) return
      const id = `${type}_${Date.now().toString(36)}`
      const position = { x: e.clientX - 400, y: e.clientY - 120 }
      setNodes((nds) =>
        nds.concat({
          id,
          type: 'default',
          position,
          data: { kind: type, label: type },
        }),
      )
    },
    [],
  )

  // 运行编排
  const onRun = useCallback(async () => {
    if (running || nodes.length === 0) return
    setRunning(true)
    setOutput('')
    const graph: WorkflowGraph = {
      nodes: nodes.map((n) => ({
        id: n.id,
        type: (n.data as { kind: NodeType }).kind,
        data: n.data as Record<string, unknown>,
        position: n.position,
      })),
      edges: edges.map((e) => ({
        source: e.source,
        target: e.target,
        condition: (e.data as { condition?: string })?.condition,
      })),
    }
    const input = window.prompt(t('editor:runPrompt')) ?? ''
    if (!input) {
      setRunning(false)
      return
    }

    const unsub = window.one.orchestrate.onStream((event: StreamEvent) => {
      switch (event.type) {
        case 'node_started':
          setActiveNode(event.node_id)
          break
        case 'node_done':
        case 'node_error':
          if (event.type === 'node_error') {
            // eslint-disable-next-line no-console
            console.error('[orchestrate] node error', event.node_id, event.error)
          }
          break
        case 'output':
          setOutput((prev) => prev + event.text)
          break
        case 'done':
        case 'failed':
          setRunning(false)
          setActiveNode(null)
          break
      }
    })

    try {
      await window.one.orchestrate.run({ graph, input }).then(unwrap)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[orchestrate] run failed', e)
      setRunning(false)
    } finally {
      unsub()
    }
  }, [nodes, edges, running, t])

  return (
    <div style={{ display: 'flex', height: '100%', gap: 12 }}>
      {/* NodePalette */}
      <aside
        className="glass-panel"
        style={{ width: 200, borderRadius: 20, padding: 14, display: 'grid', gap: 8, alignContent: 'start' }}
      >
        <p className="section-title" style={{ fontSize: '0.8rem' }}>
          {t('editor:palette.title')}
        </p>
        {NODE_TYPES.map((nt) => {
          const Icon = nt.icon
          return (
            <div
              key={nt.type}
              draggable
              onDragStart={(e) => onDragStart(e, nt.type)}
              className="surface-panel"
              style={{
                borderRadius: 12,
                padding: '10px 12px',
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                cursor: 'grab',
              }}
            >
              <Icon size={16} style={{ color: nodeColor(nt.type) }} />
              <span style={{ fontSize: '0.85rem' }}>{nt.label}</span>
            </div>
          )
        })}
        <div style={{ marginTop: 12 }}>
          <Button onClick={() => void onRun()} disabled={running} className="w-full">
            {running ? t('editor:running') : t('editor:run')}
          </Button>
        </div>
      </aside>

      {/* Canvas */}
      <div
        className="glass-panel"
        style={{ flex: 1, borderRadius: 20, overflow: 'hidden' }}
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={{}}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background color="rgba(120,130,145,0.12)" gap={20} />
          <Controls />
        </ReactFlow>
      </div>

      {/* Inspector / 运行输出 */}
      <aside
        className={`glass-panel ${activeNode ? '' : ''}`}
        style={{ width: 360, borderRadius: 20, padding: 16, display: 'grid', gap: 12, alignContent: 'start' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <p className="section-title">{t('editor:inspector.title')}</p>
          {running ? <Badge variant="brand">{t('editor:running')}</Badge> : null}
        </div>
        <p className="section-subtitle">{t('editor:inspector.hint')}</p>
        {output ? (
          <div
            className="surface-panel"
            style={{ borderRadius: 12, padding: 12, fontSize: '0.85rem', maxHeight: 400, overflow: 'auto' }}
          >
            <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'var(--font-mono, monospace)' }}>
              {output}
            </pre>
          </div>
        ) : null}
      </aside>
    </div>
  )
}
