import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Background,
  Controls,
  MiniMap,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeTypes,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  Bot,
  Boxes,
  Cable,
  GitBranch,
  Play,
  Save,
  Trash2,
  Users,
  Wrench,
  ChevronLeft,
  BookOpen,
  RefreshCw,
  Check,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { unwrap } from '@renderer/api/client'
import { useAgents, useCapability, useSaveCapability, useSkills } from '@renderer/api/hooks'
import { Button } from '@renderer/components/ui/Button'
import { Badge } from '@renderer/components/ui/Badge'
import { Input } from '@renderer/components/ui/Input'
import { AgentNodeView, type AgentNodeData, type AgentNodeStatus } from '@renderer/components/editor/AgentNodeView'
import {
  ContainerNodeView,
  type ContainerNodeData,
} from '@renderer/components/editor/ContainerNodeView'
import type { Capability, NodeType, StreamEvent, WorkflowGraph, Agent } from '@shared/types'

// —— 能力编排画布（借鉴 Proton CapabilityEditorPage）——
// Agent 节点拖入时快照全局 Agent 配置到节点 data，之后节点级独立可改（解耦）。
// 容器节点为编排容器（Sequential/Concurrent/GroupChat/Handoff/Magentic）。
// Agent 与 Container 视觉区分：实线 vs 虚线，不同背景色。
// 容器是 ReactFlow parent 节点，agent 可拖入容器成为子节点。

const PALETTE_DRAG_KEY = 'application/reactflow'

const CONTAINER_TYPES: Array<{
  type: Exclude<NodeType, 'agent'>
  label: string
  icon: typeof Boxes
  desc: string
}> = [
  { type: 'sequential', label: '顺序 Sequential', icon: GitBranch, desc: 'A → B → C 链式执行' },
  { type: 'concurrent', label: '并发 Concurrent', icon: Boxes, desc: '同时执行，结果聚合' },
  { type: 'groupchat', label: '群聊 GroupChat', icon: Users, desc: '多角色轮流发言' },
  { type: 'handoff', label: '转交 Handoff', icon: Cable, desc: '角色间自主交接' },
  { type: 'magentic', label: 'Magentic', icon: Wrench, desc: '复杂任务分解（MVP）' },
]

const CONTAINER_DEFAULT_SIZE = { width: 300, height: 180 }
const AGENT_DEFAULT_SIZE = { width: 180, height: 80 }

const nodeTypes: NodeTypes = {
  agent: AgentNodeView,
  container: ContainerNodeView,
}

/** ReactFlow 节点 data → GraphNode.type 映射 */
function rfTypeToNodeType(rfType: string, data: Record<string, unknown>): NodeType {
  if (rfType === 'agent') return 'agent'
  return (data.kind as NodeType) ?? 'sequential'
}

/** 将 WorkflowGraph 序列化为稳定 JSON 字符串，用于比较是否一致 */
function serializeGraph(graph: WorkflowGraph): string {
  return JSON.stringify({
    nodes: graph.nodes
      .map((n) => ({
        id: n.id,
        type: n.type,
        data: n.data,
        position: n.position,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: graph.edges
      .map((e) => ({ source: e.source, target: e.target, condition: e.condition }))
      .sort((a, b) => `${a.source}-${a.target}`.localeCompare(`${b.source}-${b.target}`)),
  })
}

/** 获取节点的绝对坐标（递归累加 parent 位置） */
function getAbsolutePos(node: Node, allNodes: Node[]): { x: number; y: number } {
  if (!node.parentId) return { x: node.position.x, y: node.position.y }
  const parent = allNodes.find((n) => n.id === node.parentId)
  if (!parent) return { x: node.position.x, y: node.position.y }
  const parentAbs = getAbsolutePos(parent, allNodes)
  return { x: parentAbs.x + node.position.x, y: parentAbs.y + node.position.y }
}

/** 判断 ReactFlow 节点是否为容器 */
function isContainerNode(node: Node): boolean {
  return node.type === 'container'
}

/** 拖拽数据信封 */
interface PaletteDragPayload {
  kind: 'agent' | NodeType
  agentId?: string
  agentName?: string
  model?: string
  instructions?: string
  description?: string
  skillIds?: string[]
  temperature?: number
  maxTokens?: number
  outputConstraints?: string
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
  const nav = useNavigate()
  const { screenToFlowPosition, getNodes } = useReactFlow()
  const capQ = useCapability(capabilityId)
  const saveCap = useSaveCapability()
  const agentsQ = useAgents()
  const skillsQ = useSkills()

  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [running, setRunning] = useState(false)
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [output, setOutput] = useState('')

  /** 记录最近一次加载/保存的图数据哈希，用于：
   *  1. 阻止 save → refetch → reload → save 的无限循环
   *  2. 允许数据真正变化时（重进页面、远端更新后）正常重载
   */
  const lastGraphHashRef = useRef<string>('')
  /** 记录上次显式保存时间戳，用于显示「已保存」反馈 */
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const agents: Agent[] = agentsQ.data ?? []
  const skills = skillsQ.data ?? []

  // —— 加载已有能力图 ——
  useEffect(() => {
    const cap = capQ.data as Capability | undefined
    if (!cap?.graph) return

    // 用图数据哈希守卫：如果远端数据和本地最近一次加载/保存的一致，跳过
    // 这允许远端数据真正变化时正常重载，同时打破 save → refetch → reload 循环
    const incomingHash = serializeGraph(cap.graph)
    if (incomingHash === lastGraphHashRef.current) return
    lastGraphHashRef.current = incomingHash

    // 拷贝 graph 外壳 + edges 数组：下面的归一化有 push / filter 重赋值，
    // 直接别名 capQ.data.graph 会就地污染 React Query 缓存。
    // （edges 必须一起拷——仅 { ...cap.graph } 时 push 仍会改到缓存数组；
    //   nodes 只读不改，无需拷贝。）
    const g = { ...cap.graph, edges: [...cap.graph.edges] }

    // 整理 concurrent 容器的连线：
    // - 补 container → aggregator 的视觉边（一根线代表 fan-in）
    // - 删除 participant → aggregator 的多余边（运行时由 buildConcurrent 内部处理）
    const edgeExists = (s: string, t: string) => g.edges.some((e) => e.source === s && e.target === t)
    for (const n of g.nodes) {
      if (n.type !== 'concurrent') continue
      const participants = (n.data as { participants?: string[] })?.participants ?? []
      const aggregator = (n.data as { aggregator?: string })?.aggregator
      if (!aggregator) continue
      // 补 container → aggregator
      if (!edgeExists(n.id, aggregator)) {
        g.edges.push({ source: n.id, target: aggregator })
      }
      // 删 participant → aggregator（画布不显示，运行时由 builder 加）
      g.edges = g.edges.filter(
        (e) => !(participants.includes(e.source) && e.target === aggregator),
      )
    }

    // 清理触及容器子节点的历史遗留边：画布已禁止子节点连线（isValidConnection），
    // 容器内部布线由 pattern builder 决定，旧图残留的子节点边一并剔除
    const childIds = new Set(
      g.nodes
        .filter((n) => Boolean((n.data as { parentId?: string })?.parentId))
        .map((n) => n.id),
    )
    if (childIds.size > 0) {
      g.edges = g.edges.filter(
        (e) => !childIds.has(e.source) && !childIds.has(e.target),
      )
    }

    // 第一轮：创建所有节点（暂不带 parentId）
    const loadedNodes: Node[] = g.nodes.map((n) => {
      const isAgent = n.type === 'agent'
      const rfNode: Node = {
        id: n.id,
        type: isAgent ? 'agent' : 'container',
        position: n.position,
        data: {
          ...(n.data as Record<string, unknown>),
          kind: n.type,
          label: (n.data as { label?: string })?.label ?? n.id,
        } as Record<string, unknown>,
        width: isAgent ? AGENT_DEFAULT_SIZE.width : CONTAINER_DEFAULT_SIZE.width,
        height: isAgent ? AGENT_DEFAULT_SIZE.height : CONTAINER_DEFAULT_SIZE.height,
      }
      // 恢复 parentId 关系
      const parentId = (n.data as { parentId?: string })?.parentId
      if (parentId) {
        rfNode.parentId = parentId
        rfNode.extent = 'parent' as const
      }
      return rfNode
    })

    // expandParent 设置在子节点上，让 ReactFlow 自动撑大父容器（借鉴 Proton）
    const finalNodes = loadedNodes.map((n) =>
      n.parentId ? { ...n, expandParent: true } : n,
    )

    setNodes(finalNodes)
    setEdges(
      g.edges.map((e) => ({
        id: `${e.source}-${e.target}`,
        source: e.source,
        target: e.target,
        animated: false,
        data: { condition: e.condition } as Record<string, unknown>,
      })),
    )
  }, [capQ.data])

  // —— 向后兼容：agents 加载后，为缺快照的旧节点补全配置 ——
  useEffect(() => {
    if (agents.length === 0 || nodes.length === 0) return
    let changed = false
    const patched = nodes.map((n) => {
      if (n.type !== 'agent') return n
      const d = n.data as Record<string, unknown>
      const hasSnapshot = ((d.instructions as string | undefined) ?? '').length > 0
      if (hasSnapshot) return n
      const refId = (d.sourceAgentId as string) ?? (d.agentId as string)
      if (!refId) return n
      const src = agents.find((a) => a.id === refId)
      if (!src) return n
      changed = true
      return {
        ...n,
        data: {
          ...d,
          instructions: src.instructions,
          description: src.description,
          skillIds: src.skillIds ?? [],
          modelId: src.modelId ?? '',
          model: src.modelId ?? '',
          temperature: src.temperature,
          maxTokens: src.maxTokens,
          outputConstraints: src.outputConstraints,
        } as Record<string, unknown>,
      }
    })
    if (changed) setNodes(patched)
  }, [agents, nodes])

  // —— debounce 存图（节点/边变化后 800ms 落盘）——
  useEffect(() => {
    if (!capabilityId || (nodes.length === 0 && edges.length === 0)) return
    const timer = setTimeout(() => {
      const graph: WorkflowGraph = {
        nodes: nodes.map((n) => ({
          id: n.id,
          type: rfTypeToNodeType(n.type ?? 'agent', n.data as Record<string, unknown>),
          data: {
            ...(n.data as Record<string, unknown>),
            label: (n.data as { label?: string })?.label ?? n.id,
            parentId: n.parentId,
          },
          position: n.position,
        })),
        edges: edges.map((e) => ({
          source: e.source,
          target: e.target,
          condition: (e.data as { condition?: string })?.condition,
        })),
      }
      // 跳过与上次完全相同的图数据（避免 save → refetch → reload 循环）
      const currentHash = serializeGraph(graph)
      if (currentHash === lastGraphHashRef.current) return
      lastGraphHashRef.current = currentHash

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

  // —— ReactFlow 变更回调 ——
  // 用默认 applyNodeChanges，ReactFlow 内建 expandParent 自动撑大容器
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((nds) => applyNodeChanges(changes, nds))
    },
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

  // —— 连线校验：容器子节点不参与画布连线 ——
  // 容器内部布线由 pattern builder 全权决定（sequential 按 participants 顺序连链、
  // groupchat 经容器广播、handoff 走 synthetic tool），子节点手动连线会与容器
  // 语义叠加冲突（双投递 / hasCycle 检测不到的运行时环），故仅允许顶层节点互连。
  const isValidConnection = useCallback(
    (conn: Connection | Edge) => {
      if (!conn.source || !conn.target || conn.source === conn.target) return false
      const all = getNodes()
      const src = all.find((n) => n.id === conn.source)
      const tgt = all.find((n) => n.id === conn.target)
      if (!src || !tgt) return false
      return !src.parentId && !tgt.parentId
    },
    [getNodes],
  )

  // —— 选中节点 ——
  const onNodeClick = useCallback((_: unknown, node: Node) => {
    setSelectedNodeId(node.id)
  }, [])
  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null)
  }, [])

  // —— 拖拽起始（从 Palette）——
  const onPaletteDragStart = (e: React.DragEvent, payload: PaletteDragPayload): void => {
    e.dataTransfer.setData(PALETTE_DRAG_KEY, JSON.stringify(payload))
    e.dataTransfer.effectAllowed = 'move'
  }

  // —— 检测坐标落在哪个容器内 ——
  const containerAt = useCallback(
    (pos: { x: number; y: number }): Node | null => {
      const allNodes = getNodes()
      for (const n of allNodes) {
        if (!isContainerNode(n)) continue
        // 优先用 measured（实际渲染尺寸），expandParent 撑大后 measured 更准确
        const w = n.measured?.width ?? n.width ?? CONTAINER_DEFAULT_SIZE.width
        const h = n.measured?.height ?? n.height ?? CONTAINER_DEFAULT_SIZE.height
        const absX = n.position.x
        const absY = n.position.y
        if (
          pos.x >= absX &&
          pos.x <= absX + w &&
          pos.y >= absY &&
          pos.y <= absY + h
        ) {
          return n
        }
      }
      return null
    },
    [getNodes],
  )

  // —— 拖放到画布 ——
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const raw = e.dataTransfer.getData(PALETTE_DRAG_KEY)
      if (!raw) return
      let payload: PaletteDragPayload
      try {
        payload = JSON.parse(raw) as PaletteDragPayload
      } catch {
        return
      }

      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const container = containerAt(position)
      const isAgent = payload.kind === 'agent'

      const nodeId = isAgent
        ? `agent_${Date.now().toString(36)}`
        : `${payload.kind}_${Date.now().toString(36)}`

      const newNode: Node = {
        id: nodeId,
        type: isAgent ? 'agent' : 'container',
        position: container
          ? { x: position.x - container.position.x, y: position.y - container.position.y }
          : position,
        data: isAgent
          ? ({
              kind: 'agent' as const,
              label: payload.agentName ?? 'Agent',
              sourceAgentId: payload.agentId ?? '',
              instructions: payload.instructions ?? '',
              description: payload.description,
              skillIds: payload.skillIds ?? [],
              modelId: payload.model ?? '',
              model: payload.model ?? '',
              temperature: payload.temperature,
              maxTokens: payload.maxTokens,
              outputConstraints: payload.outputConstraints,
              status: 'idle' as AgentNodeStatus,
              isEntry: nodes.filter((n) => n.type === 'agent').length === 0,
            } satisfies AgentNodeData)
          : ({
              kind: payload.kind as NodeType,
              label: CONTAINER_TYPES.find((c) => c.type === payload.kind)?.label ?? payload.kind,
              status: 'idle' as AgentNodeStatus,
              participants: [],
              dropHover: false,
              selectorMode: 'round_robin',
              maxRounds: 6,
            } satisfies ContainerNodeData),
        width: isAgent ? AGENT_DEFAULT_SIZE.width : CONTAINER_DEFAULT_SIZE.width,
        height: isAgent ? AGENT_DEFAULT_SIZE.height : CONTAINER_DEFAULT_SIZE.height,
      }

      // 如果落在容器内，设置为子节点
      if (container && isAgent) {
        newNode.parentId = container.id
        newNode.extent = 'parent' as const
        newNode.expandParent = true // 让 ReactFlow 自动撑大父容器
        // 更新容器的 participants
        setNodes((nds) => {
          const updated = nds.map((n) => {
            if (n.id === container.id) {
              const existing = (n.data as ContainerNodeData).participants ?? []
              return {
                ...n,
                data: {
                  ...n.data,
                  participants: [...existing, nodeId],
                  dropHover: false,
                } as ContainerNodeData,
              }
            }
            // 清除其他容器的 dropHover
            if (isContainerNode(n)) {
              return { ...n, data: { ...n.data, dropHover: false } }
            }
            return n
          })
          return [...updated, newNode]
        })
      } else {
        // 容器节点需要 expandParent
        if (!isAgent) {
          newNode.expandParent = true
        }
        setNodes((nds) =>
          nds.map((n) =>
            isContainerNode(n)
              ? { ...n, data: { ...n.data, dropHover: false } }
              : n,
          ).concat(newNode),
        )
      }
    },
    [screenToFlowPosition, containerAt, nodes],
  )

  // —— 拖动节点时高亮容器 ——
  // 检测逻辑放在 setNodes 回调内，用 nds（最新 React state）而非 getNodes()
  // 避免 expandParent 撑大后 measured 尺寸未及时更新导致误判
  // ⚠ xyflow v12 用户节点没有 positionAbsolute（只在 internals 里）；
  //   子节点 node.position 是父容器相对坐标，必须经 getAbsolutePos 转成
  //   画布绝对坐标后，才能与容器绝对坐标做命中检测。
  const onNodeDrag = useCallback(
    (_: unknown, node: Node) => {
      if (node.type !== 'agent') return
      const w = node.measured?.width ?? node.width ?? AGENT_DEFAULT_SIZE.width
      const h = node.measured?.height ?? node.height ?? AGENT_DEFAULT_SIZE.height

      setNodes((nds) => {
        // 在 setNodes 回调内用 nds 检测（最新 state）；
        // node 是回调实参（携带拖拽中的最新相对坐标），parent 链从 nds 取
        const abs = getAbsolutePos(node, nds)
        const centerX = abs.x + w / 2
        const centerY = abs.y + h / 2

        let hoverId: string | undefined
        for (const cn of nds) {
          if (!isContainerNode(cn)) continue
          const cw = cn.measured?.width ?? cn.width ?? CONTAINER_DEFAULT_SIZE.width
          const ch = cn.measured?.height ?? cn.height ?? CONTAINER_DEFAULT_SIZE.height
          const cnAbs = getAbsolutePos(cn, nds)
          if (
            centerX >= cnAbs.x &&
            centerX <= cnAbs.x + cw &&
            centerY >= cnAbs.y &&
            centerY <= cnAbs.y + ch
          ) {
            hoverId = cn.id
            break
          }
        }

        let changed = false
        const result = nds.map((n) => {
          if (!isContainerNode(n)) return n
          const shouldHover = hoverId === n.id
          const currentlyHover = (n.data as ContainerNodeData).dropHover ?? false
          if (shouldHover === currentlyHover) return n
          changed = true
          return { ...n, data: { ...n.data, dropHover: shouldHover } }
        })
        return changed ? result : nds
      })
    },
    [],
  )

  // —— 拖动结束时更新 parent-child 关系 ——
  // 核心改进：
  // 1. 容器检测在 setNodes 回调内用 nds（最新 state），避免 getNodes() 时序不同步
  // 2. 坐标系统一：xyflow v12 用户节点无 positionAbsolute，子节点 position 是
  //    父容器相对坐标，一律经 getAbsolutePos 转绝对坐标后再命中/换算
  // 3. 容差检测：如果 agent 已有 parent 但没检测到目标容器，
  //    检查中心是否仍在原父容器附近（容差 60px），是则不移出
  //    这解决了 expandParent 撑大容器时 measured 未及时更新导致误移出的问题
  const onNodeDragStop = useCallback(
    (_: unknown, node: Node) => {
      if (node.type !== 'agent') return
      const w = node.measured?.width ?? node.width ?? AGENT_DEFAULT_SIZE.width
      const h = node.measured?.height ?? node.height ?? AGENT_DEFAULT_SIZE.height

      setNodes((nds) => {
        // node 是回调实参（携带拖拽结束时的最新相对坐标），parent 链从 nds 取
        const abs = getAbsolutePos(node, nds)
        const centerX = abs.x + w / 2
        const centerY = abs.y + h / 2

        // 在 setNodes 回调内用 nds 检测中心点所在容器
        let newParentId: string | undefined
        let newParentAbs: { x: number; y: number } | undefined
        for (const cn of nds) {
          if (!isContainerNode(cn)) continue
          const cw = cn.measured?.width ?? cn.width ?? CONTAINER_DEFAULT_SIZE.width
          const ch = cn.measured?.height ?? cn.height ?? CONTAINER_DEFAULT_SIZE.height
          const cnAbs = getAbsolutePos(cn, nds)
          if (
            centerX >= cnAbs.x &&
            centerX <= cnAbs.x + cw &&
            centerY >= cnAbs.y &&
            centerY <= cnAbs.y + ch
          ) {
            newParentId = cn.id
            newParentAbs = cnAbs
            break
          }
        }

        let changed = false
        const updated = nds.map((n) => {
          // 清除所有 dropHover
          if (isContainerNode(n)) {
            const dh = (n.data as ContainerNodeData).dropHover ?? false
            if (dh) {
              changed = true
              return { ...n, data: { ...n.data, dropHover: false } }
            }
            return n
          }
          // 处理被拖动的 agent 节点
          if (n.id === node.id) {
            const oldParentId = n.parentId

            if (oldParentId === newParentId) return n // 没变化

            // 容差检测：已有父容器但没检测到目标容器时，
            // 检查中心是否仍在原父容器附近（expandParent 撑大后 measured 可能未更新）
            if (oldParentId && !newParentId) {
              const oldParent = nds.find((on) => on.id === oldParentId)
              if (oldParent) {
                const pw = oldParent.measured?.width ?? oldParent.width ?? CONTAINER_DEFAULT_SIZE.width
                const ph = oldParent.measured?.height ?? oldParent.height ?? CONTAINER_DEFAULT_SIZE.height
                const oldParentAbs = getAbsolutePos(oldParent, nds)
                const TOLERANCE = 60
                if (
                  centerX >= oldParentAbs.x - TOLERANCE &&
                  centerX <= oldParentAbs.x + pw + TOLERANCE &&
                  centerY >= oldParentAbs.y - TOLERANCE &&
                  centerY <= oldParentAbs.y + ph + TOLERANCE
                ) {
                  return n // 仍在原容器附近，不移出
                }
              }
            }

            changed = true
            if (newParentId && newParentAbs) {
              // 移入新容器（绝对坐标 → 容器内相对坐标）
              return {
                ...n,
                parentId: newParentId,
                extent: 'parent' as const,
                expandParent: true,
                position: {
                  x: centerX - newParentAbs.x - w / 2,
                  y: centerY - newParentAbs.y - h / 2,
                },
              }
            }
            // 移出容器到画布
            return {
              ...n,
              parentId: undefined,
              extent: undefined,
              expandParent: undefined,
              position: { x: centerX - w / 2, y: centerY - h / 2 },
            }
          }
          return n
        })

        if (!changed) return updated

        // 更新容器的 participants 列表
        const withParticipants = updated.map((n) => {
          if (!isContainerNode(n)) return n
          const children = updated.filter(
            (c) => c.id !== n.id && c.parentId === n.id,
          )
          const participants = children.map((c) => c.id)
          const oldParticipants = (n.data as ContainerNodeData).participants ?? []
          if (
            participants.length === oldParticipants.length &&
            participants.every((p) => oldParticipants.includes(p))
          ) {
            return n
          }
          return { ...n, data: { ...n.data, participants } }
        })
        return withParticipants
      })
    },
    [],
  )

  // —— 删除节点 ——
  const onDeleteNode = useCallback(
    (id: string) => {
      setNodes((nds) => {
        // 如果是容器，先解除子节点的 parent 关系
        const target = nds.find((n) => n.id === id)
        if (target && isContainerNode(target)) {
          const freed = nds
            .filter((n) => n.id !== id)
            .map((n) =>
              n.parentId === id
                ? { ...n, parentId: undefined, extent: undefined, expandParent: undefined, position: getAbsolutePos(n, nds.filter((x) => x.id !== id)) }
                : n,
            )
          return freed
        }
        // 如果是 agent，从父容器的 participants 中移除
        const after = nds.map((n) => {
          if (!isContainerNode(n)) return n
          const participants = (n.data as ContainerNodeData).participants ?? []
          if (!participants.includes(id)) return n
          return {
            ...n,
            data: {
              ...n.data,
              participants: participants.filter((p) => p !== id),
            },
          }
        }).filter((n) => n.id !== id)
        return after
      })
      setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id))
      if (selectedNodeId === id) setSelectedNodeId(null)
    },
    [selectedNodeId],
  )

  // —— 更新节点 data（Inspector 编辑用）——
  const updateNodeData = useCallback(
    (id: string, patch: Record<string, unknown>) => {
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id
            ? { ...n, data: { ...n.data, ...patch } }
            : n,
        ),
      )
    },
    [],
  )

  // —— 显式保存 ——
  const onSaveNow = useCallback(async () => {
    if (!capabilityId || nodes.length === 0) return
    const graph: WorkflowGraph = {
      nodes: nodes.map((n) => ({
        id: n.id,
        type: rfTypeToNodeType(n.type ?? 'agent', n.data as Record<string, unknown>),
        data: {
          ...(n.data as Record<string, unknown>),
          label: (n.data as { label?: string })?.label ?? n.id,
          parentId: n.parentId,
        },
        position: n.position,
      })),
      edges: edges.map((e) => ({
        source: e.source,
        target: e.target,
        condition: (e.data as { condition?: string })?.condition,
      })),
    }
    lastGraphHashRef.current = serializeGraph(graph)
    const cap = capQ.data as Capability | undefined
    await saveCap.mutateAsync({
      id: capabilityId,
      name: cap?.name ?? '未命名',
      description: cap?.description,
      graph,
    })
    setSavedAt(Date.now())
  }, [capabilityId, nodes, edges, saveCap, capQ.data])

  // —— 运行编排 ——
  const onRun = useCallback(async () => {
    if (running || nodes.length === 0) return
    setRunning(true)
    setOutput('')
    // 清除所有节点状态
    setNodes((nds) =>
      nds.map((n) => ({
        ...n,
        data: { ...n.data, status: 'idle' as AgentNodeStatus },
      })),
    )

    const graph: WorkflowGraph = {
      nodes: nodes.map((n) => ({
        id: n.id,
        type: rfTypeToNodeType(n.type ?? 'agent', n.data as Record<string, unknown>),
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
          setActiveNodeId(event.node_id)
          setNodes((nds) =>
            nds.map((n) =>
              n.id === event.node_id
                ? { ...n, data: { ...n.data, status: 'running' as AgentNodeStatus } }
                : n,
            ),
          )
          break
        case 'node_done':
          setNodes((nds) =>
            nds.map((n) =>
              n.id === event.node_id
                ? { ...n, data: { ...n.data, status: 'done' as AgentNodeStatus } }
                : n,
            ),
          )
          break
        case 'node_error':
          setNodes((nds) =>
            nds.map((n) =>
              n.id === event.node_id
                ? { ...n, data: { ...n.data, status: 'error' as AgentNodeStatus } }
                : n,
            ),
          )
          break
        case 'output':
          setOutput((prev) => prev + event.text)
          break
        case 'done':
        case 'failed':
          setRunning(false)
          setActiveNodeId(null)
          break
      }
    })

    try {
      await window.one.orchestrate.run({ graph, input }).then(unwrap)
    } catch {
      setRunning(false)
    } finally {
      unsub()
    }
  }, [nodes, edges, running, t])

  // —— 选中节点 ——
  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null
  const cap = capQ.data as Capability | undefined

  return (
    <div style={{ display: 'flex', height: '100%', gap: 12 }}>
      {/* ── NodePalette ── */}
      <aside
        className="glass-panel"
        style={{
          width: 220,
          borderRadius: 20,
          padding: 14,
          display: 'grid',
          gap: 10,
          alignContent: 'start',
          overflow: 'auto',
        }}
      >
        {/* 返回按钮 */}
        <button
          type="button"
          onClick={() => nav('/capabilities')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            border: 0,
            background: 'transparent',
            color: 'var(--color-fg-2)',
            cursor: 'pointer',
            fontSize: '0.8rem',
            padding: '4px 0',
          }}
        >
          <ChevronLeft size={14} /> {t('editor:back')}
        </button>

        {/* 能力名称 */}
        <div>
          <p className="section-title" style={{ fontSize: '0.9rem' }}>
            {cap?.name ?? '…'}
          </p>
          {cap?.description ? (
            <p className="section-subtitle" style={{ fontSize: '0.75rem' }}>
              {cap.description}
            </p>
          ) : null}
        </div>

        {/* ── 第1组：角色 Agent ── */}
        <div className="rf-palette-group">
          <p className="rf-palette-group__title">
            {t('editor:palette.agents')}
          </p>
          {agentsQ.isLoading ? (
            <p className="rf-palette-hint">{t('common:state.loading')}</p>
          ) : agents.length === 0 ? (
            <button
              type="button"
              onClick={() => nav('/agents')}
              className="rf-palette-empty"
            >
              {t('editor:palette.noAgents')}
            </button>
          ) : (
            agents.map((a) => (
              <div
                key={a.id}
                draggable
                onDragStart={(e) =>
                  onPaletteDragStart(e, {
                    kind: 'agent',
                    agentId: a.id,
                    agentName: a.name,
                    model: a.modelId ?? '',
                    instructions: a.instructions,
                    description: a.description,
                    skillIds: a.skillIds,
                    temperature: a.temperature,
                    maxTokens: a.maxTokens,
                    outputConstraints: a.outputConstraints,
                  })
                }
                className="rf-palette-item rf-palette-item--agent"
              >
                <Bot size={14} style={{ color: 'var(--color-brand-500)', flexShrink: 0 }} />
                <span className="rf-palette-item__label">{a.name}</span>
              </div>
            ))
          )}
        </div>

        {/* ── 第2组：编排容器 ── */}
        <div className="rf-palette-group">
          <p className="rf-palette-group__title">
            {t('editor:palette.containers')}
          </p>
          {CONTAINER_TYPES.map((c) => {
            const Icon = c.icon
            return (
              <div
                key={c.type}
                draggable
                onDragStart={(e) => onPaletteDragStart(e, { kind: c.type })}
                className="rf-palette-item rf-palette-item--container"
                title={c.desc}
              >
                <Icon size={14} style={{ flexShrink: 0 }} />
                <span className="rf-palette-item__label">{c.label}</span>
              </div>
            )
          })}
        </div>

        {/* 保存 + 运行按钮 */}
        <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
          <Button
            onClick={() => void onSaveNow()}
            disabled={saveCap.isPending || nodes.length === 0}
            variant="ghost"
            className="w-full"
          >
            {saveCap.isPending ? (
              <>
                <RefreshCw size={14} className="animate-spin" /> 保存中…
              </>
            ) : savedAt && Date.now() - savedAt < 3000 ? (
              <>
                <Check size={14} /> 已保存
              </>
            ) : (
              <>
                <Save size={14} /> 保存
              </>
            )}
          </Button>
          <Button
            onClick={() => void onRun()}
            disabled={running || nodes.length === 0}
            className="w-full"
          >
            <Play size={14} />
            {running ? t('editor:running') : t('editor:run')}
          </Button>
        </div>
      </aside>

      {/* ── Canvas ── */}
      <div
        className="glass-panel"
        style={{ flex: 1, borderRadius: 20, overflow: 'hidden', position: 'relative' }}
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          nodeTypes={nodeTypes}
          fitView
          proOptions={{ hideAttribution: true }}
          deleteKeyCode={['Backspace', 'Delete']}
        >
          <Background color="rgba(120,130,145,0.12)" gap={20} />
          <Controls />
          <MiniMap
            nodeColor={(n) => {
              if (n.type === 'agent') return 'var(--color-brand-400)'
              return 'var(--color-bg-3)'
            }}
            style={{ borderRadius: 12 }}
          />
        </ReactFlow>

        {/* 运行态高亮指示 */}
        {activeNodeId ? (
          <div
            style={{
              position: 'absolute',
              top: 12,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 10,
            }}
          >
            <Badge variant="brand">{t('editor:running')} · {activeNodeId}</Badge>
          </div>
        ) : null}
      </div>

      {/* ── Inspector ── */}
      <aside
        className="glass-panel"
        style={{
          width: 340,
          borderRadius: 20,
          padding: 16,
          display: 'grid',
          gap: 12,
          alignContent: 'start',
          overflow: 'auto',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <p className="section-title" style={{ fontSize: '0.9rem' }}>
            {t('editor:inspector.title')}
          </p>
          {running ? <Badge variant="brand">{t('editor:running')}</Badge> : null}
        </div>

        {selectedNode ? (
          <NodeInspector
            node={selectedNode}
            nodes={nodes}
            skills={skills}
            agents={agents}
            onUpdate={updateNodeData}
            onDelete={onDeleteNode}
            t={t}
          />
        ) : (
          <p className="section-subtitle">{t('editor:inspector.hint')}</p>
        )}

        {/* 运行输出 */}
        {output ? (
          <div
            className="surface-panel"
            style={{ borderRadius: 12, padding: 12, fontSize: '0.85rem', maxHeight: 300, overflow: 'auto' }}
          >
            <p className="section-subtitle" style={{ fontSize: '0.75rem', marginBottom: 8 }}>
              {t('editor:output')}
            </p>
            <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'var(--font-mono, monospace)' }}>
              {output}
            </pre>
          </div>
        ) : null}
      </aside>
    </div>
  )
}

// —— 节点属性检查器 ——
function NodeInspector({
  node,
  nodes,
  skills,
  agents,
  onUpdate,
  onDelete,
  t,
}: {
  node: Node
  nodes: Node[]
  skills: Array<{ id: string; name: string }>
  agents: Agent[]
  onUpdate: (id: string, patch: Record<string, unknown>) => void
  onDelete: (id: string) => void
  t: (key: string) => string
}) {
  const data = node.data as Record<string, unknown> & {
    label?: string
    kind: NodeType
    status?: AgentNodeStatus
    sourceAgentId?: string
    instructions?: string
    description?: string
    skillIds?: string[]
    modelId?: string
    temperature?: number
    maxTokens?: number
    outputConstraints?: string
    model?: string
    isEntry?: boolean
    participants?: string[]
    dropHover?: boolean
    selectorMode?: 'round_robin' | 'manager'
    maxRounds?: number
    startAgent?: string
  }
  const isAgent = node.type === 'agent'
  const status = data.status ?? 'idle'

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {/* 基本信息 */}
      <div className="surface-panel" style={{ borderRadius: 12, padding: 12, display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Badge variant={isAgent ? 'brand' : 'default'} style={{ fontSize: '0.7rem' }}>
            {isAgent ? 'Agent' : 'Container'}
          </Badge>
          <span style={{ fontSize: '0.75rem', color: 'var(--color-fg-3)' }}>
            {t(`editor:status.${status}`)}
          </span>
        </div>
        <div>
          <label className="rf-inspector-label">名称</label>
          <Input
            value={data.label ?? ''}
            onChange={(e) => onUpdate(node.id, { label: e.target.value })}
            style={{ marginTop: 4 }}
          />
        </div>
      </div>

      {/* Agent 特有属性 */}
      {isAgent ? (
        <div className="surface-panel" style={{ borderRadius: 12, padding: 12, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <p className="rf-inspector-section" style={{ margin: 0 }}>节点配置</p>
            {data.sourceAgentId ? (
              <button
                type="button"
                onClick={() => {
                  const src = agents.find((a) => a.id === data.sourceAgentId)
                  if (!src) return
                  onUpdate(node.id, {
                    instructions: src.instructions,
                    description: src.description,
                    skillIds: src.skillIds ?? [],
                    modelId: src.modelId ?? '',
                    model: src.modelId ?? '',
                    temperature: src.temperature,
                    maxTokens: src.maxTokens,
                    outputConstraints: src.outputConstraints,
                  })
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: '0.72rem',
                  border: '1px solid var(--color-border)',
                  background: 'var(--color-bg-2)',
                  color: 'var(--color-fg-2)',
                  borderRadius: 8,
                  padding: '3px 8px',
                  cursor: 'pointer',
                }}
                title="从全局角色模板重新拉取配置（覆盖当前节点配置）"
              >
                <RefreshCw size={11} /> 从模板刷新
              </button>
            ) : null}
          </div>
          {data.sourceAgentId ? (
            <p style={{ fontSize: '0.7rem', color: 'var(--color-fg-3)', margin: 0 }}>
              源模板: {data.sourceAgentId}
            </p>
          ) : null}
          <div>
            <label className="rf-inspector-label">描述</label>
            <Input
              value={data.description ?? ''}
              onChange={(e) => onUpdate(node.id, { description: e.target.value })}
              placeholder="角色的简要描述"
              style={{ marginTop: 4 }}
            />
          </div>
          <div>
            <label className="rf-inspector-label">System Prompt</label>
            <textarea
              value={data.instructions ?? ''}
              onChange={(e) => onUpdate(node.id, { instructions: e.target.value })}
              placeholder="输入 system prompt"
              style={{
                marginTop: 4,
                width: '100%',
                minHeight: 80,
                fontSize: '0.8rem',
                resize: 'vertical',
                background: 'var(--color-bg-2)',
                border: '1px solid var(--color-border)',
                borderRadius: 8,
                padding: 8,
                color: 'var(--color-fg-1)',
              }}
            />
          </div>
          <div>
            <label className="rf-inspector-label">模型</label>
            <Input
              value={data.model ?? ''}
              onChange={(e) => onUpdate(node.id, { model: e.target.value, modelId: e.target.value })}
              placeholder="留空用默认"
              style={{ marginTop: 4 }}
            />
          </div>
          <div>
            <label className="rf-inspector-label">输出约束</label>
            <Input
              value={data.outputConstraints ?? ''}
              onChange={(e) => onUpdate(node.id, { outputConstraints: e.target.value })}
              placeholder="如：≤2500字"
              style={{ marginTop: 4 }}
            />
          </div>
          {/* 挂载技能 */}
          <div>
            <label className="rf-inspector-label">挂载技能</label>
            {skills.length === 0 ? (
              <p style={{ fontSize: '0.75rem', color: 'var(--color-fg-3)', margin: '4px 0 0' }}>
                暂无可用技能
              </p>
            ) : (
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 4 }}>
                {skills.map((s) => {
                  const active = (data.skillIds ?? []).includes(s.id)
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => {
                        const current = data.skillIds ?? []
                        onUpdate(node.id, {
                          skillIds: active
                            ? current.filter((id) => id !== s.id)
                            : [...current, s.id],
                        })
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 3,
                        padding: '3px 8px',
                        borderRadius: 999,
                        fontSize: '0.72rem',
                        cursor: 'pointer',
                        border: active
                          ? '1px solid var(--color-brand-500)'
                          : '1px solid var(--color-border)',
                        background: active
                          ? 'color-mix(in srgb, var(--color-brand-500) 15%, transparent)'
                          : 'var(--color-bg-2)',
                        color: active
                          ? 'var(--color-brand-500)'
                          : 'var(--color-fg-2)',
                        transition: 'all 120ms ease',
                      }}
                    >
                      <BookOpen size={10} />
                      {s.name}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem' }}>
            <input
              type="checkbox"
              checked={data.isEntry ?? false}
              onChange={(e) => onUpdate(node.id, { isEntry: e.target.checked })}
            />
            设为入口节点
          </label>
        </div>
      ) : null}

      {/* Container 特有属性 */}
      {!isAgent ? (
        <div className="surface-panel" style={{ borderRadius: 12, padding: 12, display: 'grid', gap: 8 }}>
          <p className="rf-inspector-section">容器配置</p>
          <div>
            <label className="rf-inspector-label">类型</label>
            <p style={{ fontSize: '0.8rem', margin: '4px 0 0', color: 'var(--color-fg-1)' }}>
              {CONTAINER_TYPES.find((c) => c.type === data.kind)?.label ?? data.kind}
            </p>
          </div>

          {/* 子节点列表 */}
          <div>
            <label className="rf-inspector-label">
              子 Agent（{(data.participants ?? []).length}）
            </label>
            {(data.participants ?? []).length === 0 ? (
              <p style={{ fontSize: '0.75rem', color: 'var(--color-fg-3)', margin: '4px 0 0' }}>
                从左侧拖入 Agent 到此容器
              </p>
            ) : (
              <div style={{ display: 'grid', gap: 4, marginTop: 4 }}>
                {(data.participants ?? []).map((pid) => {
                  const childNode = nodes.find((n) => n.id === pid)
                  const childLabel = (childNode?.data as { label?: string })?.label ?? pid
                  return (
                    <div
                      key={pid}
                      style={{
                        fontSize: '0.75rem',
                        padding: '4px 8px',
                        borderRadius: 8,
                        background: 'var(--color-bg-3)',
                        color: 'var(--color-fg-2)',
                      }}
                    >
                      {childLabel}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* GroupChat 配置 */}
          {data.kind === 'groupchat' ? (
            <>
              <div>
                <label className="rf-inspector-label">选择模式</label>
                <select
                  value={data.selectorMode ?? 'round_robin'}
                  onChange={(e) => onUpdate(node.id, { selectorMode: e.target.value })}
                  style={selectStyle}
                >
                  <option value="round_robin">轮流发言</option>
                  <option value="manager">管理者选择</option>
                </select>
              </div>
              <div>
                <label className="rf-inspector-label">最大轮数</label>
                <Input
                  type="number"
                  value={String(data.maxRounds ?? 6)}
                  onChange={(e) => onUpdate(node.id, { maxRounds: parseInt(e.target.value) || 6 })}
                  style={{ marginTop: 4 }}
                />
              </div>
            </>
          ) : null}

          {/* Handoff 配置 */}
          {data.kind === 'handoff' ? (
            <div>
              <label className="rf-inspector-label">起始 Agent</label>
              <select
                value={data.startAgent ?? ''}
                onChange={(e) => onUpdate(node.id, { startAgent: e.target.value })}
                style={selectStyle}
              >
                <option value="">自动选择</option>
                {(data.participants ?? []).map((pid) => (
                  <option key={pid} value={pid}>{pid}</option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 删除按钮 */}
      <Button variant="ghost" onClick={() => onDelete(node.id)} className="w-full">
        <Trash2 size={14} /> {t('common:actions.delete')}
      </Button>
    </div>
  )
}

const selectStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 36,
  borderRadius: 10,
  border: '1px solid var(--color-border)',
  background: 'var(--color-bg-1)',
  color: 'var(--color-fg-1)',
  padding: '8px 10px',
  fontSize: '0.875rem',
  marginTop: 4,
}
