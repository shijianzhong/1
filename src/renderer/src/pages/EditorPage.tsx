import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
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
  History,
  MessageSquare,
  SlidersHorizontal,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { unwrap } from '@renderer/api/client'
import { useAgents, useCapability, useSaveCapability, useSessions, useSkills } from '@renderer/api/hooks'
import { Button } from '@renderer/components/ui/Button'
import { Badge } from '@renderer/components/ui/Badge'
import { Input } from '@renderer/components/ui/Input'
import { AgentNodeView, type AgentNodeData, type AgentNodeStatus } from '@renderer/components/editor/AgentNodeView'
import {
  ContainerNodeView,
  type ContainerNodeData,
} from '@renderer/components/editor/ContainerNodeView'
import { RunChatPanel } from '@renderer/components/editor/RunChatPanel'
import { applyOrchEvent } from '@renderer/components/orchestra/reducer'
import { toChatMessages, type ChatMessage } from '@renderer/components/orchestra/types'
import { useSpeakerNames } from '@renderer/components/orchestra/useSpeakerNames'
import type { Capability, NodeType, StreamEvent, WorkflowGraph, Agent } from '@shared/types'

// —— 能力编排画布（借鉴 Proton CapabilityEditorPage）——
// Agent 节点拖入时快照全局 Agent 配置到节点 data，之后节点级独立可改（解耦）。
// 容器节点为编排容器（Sequential/Concurrent/GroupChat/Handoff/Magentic）。
// Agent 与 Container 视觉区分：实线 vs 虚线，不同背景色。
// 容器是 ReactFlow parent 节点，agent 可拖入容器成为子节点。

const PALETTE_DRAG_KEY = 'application/reactflow'

const CONTAINER_TYPES: Array<{
  type: Exclude<NodeType, 'agent'>
  labelKey: string
  icon: typeof Boxes
  descKey: string
}> = [
  { type: 'sequential', labelKey: 'palette.seqLabel', icon: GitBranch, descKey: 'palette.seqDesc' },
  { type: 'concurrent', labelKey: 'palette.concurrentLabel', icon: Boxes, descKey: 'palette.concurrentDesc' },
  { type: 'groupchat', labelKey: 'palette.groupchatLabel', icon: Users, descKey: 'palette.groupchatDesc' },
  { type: 'handoff', labelKey: 'palette.handoffLabel', icon: Cable, descKey: 'palette.handoffDesc' },
  { type: 'magentic', labelKey: 'palette.magenticLabel', icon: Wrench, descKey: 'palette.magenticDesc' },
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
  const [searchParams] = useSearchParams()
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
  // —— 运行对话（与首页 @能力 运行同一聊天体系：能力运行中可能与用户交互）——
  // 右侧栏 tabs：inspector 属性 / chat 运行对话；composer 第一条消息即任务输入。
  const [rightTab, setRightTab] = useState<'inspector' | 'chat'>('inspector')
  const [chatMsgs, setChatMsgs] = useState<ChatMessage[]>([])
  // —— 右栏宽度：聊天内容（markdown/卡片）340px 太窄需横向滚动——
  // 左缘拖拽手柄可调（300–760）；切到对话 tab 且用户未手动调过 → 自动放宽到 520。
  const [asideW, setAsideW] = useState(340)
  const asideManualRef = useRef(false)
  const speakerName = useSpeakerNames()

  const switchRightTab = useCallback((tab: 'inspector' | 'chat') => {
    if (tab === 'chat' && !asideManualRef.current) setAsideW(520)
    setRightTab(tab)
  }, [])

  const onAsideDragStart = useCallback((e: ReactMouseEvent) => {
    e.preventDefault()
    asideManualRef.current = true
    const startX = e.clientX
    const startW = asideW
    // 手柄在 aside 左缘：向左拖 → 变宽
    const onMove = (ev: MouseEvent): void => {
      setAsideW(Math.min(760, Math.max(300, startW + (startX - ev.clientX))))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [asideW])

  /** 记录最近一次加载/保存的图数据哈希，用于：
   *  1. 阻止 save → refetch → reload → save 的无限循环
   *  2. 允许数据真正变化时（重进页面、远端更新后）正常重载
   */
  const lastGraphHashRef = useRef<string>('')
  /** 记录上次显式保存时间戳，用于显示「已保存」反馈 */
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const agents: Agent[] = agentsQ.data ?? []
  const skills = skillsQ.data ?? []

  // —— 试跑记录回看：加载指定运行会话到运行对话 tab（只读回看；
  //    再次发送 = 新对话新运行（新建 session），不续写该会话）——
  const loadedSessionRef = useRef<string | null>(null)
  const loadRunSession = useCallback(async (sid: string) => {
    try {
      const msgs = await window.one.sessions.messages(sid).then(unwrap)
      loadedSessionRef.current = sid
      setChatMsgs(toChatMessages(msgs))
      if (!asideManualRef.current) setAsideW(520)
      setRightTab('chat')
    } catch (e) {
      console.warn('[editor] 加载运行会话失败', e)
    }
  }, [])

  // ?session=xxx 深链回看（历史下拉/外部跳转共用 loadRunSession）
  const sessionParam = searchParams.get('session')
  useEffect(() => {
    if (!sessionParam || sessionParam === loadedSessionRef.current) return
    void loadRunSession(sessionParam)
  }, [sessionParam, loadRunSession])

  // 本能力的试跑记录（capabilityId 关联会话；不进主 Agent 会话列表，这里回看）
  const qc = useQueryClient()
  const sessionsQ = useSessions()
  const [historyOpen, setHistoryOpen] = useState(false)
  const runHistory = useMemo(
    () =>
      (sessionsQ.data ?? [])
        .filter((s) => s.capabilityId === capabilityId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 20),
    [sessionsQ.data, capabilityId],
  )

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
        name: cap?.name ?? t('editor:untitled'),
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
      const containerMeta = isAgent ? undefined : CONTAINER_TYPES.find((c) => c.type === payload.kind)

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
              // 不再自动 isEntry：入口由拓扑推导兜底，用户可在 Inspector 显式指定
            } satisfies AgentNodeData)
          : ({
              kind: payload.kind as NodeType,
              label: containerMeta ? t(`editor:${containerMeta.labelKey}`) : payload.kind,
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
    [screenToFlowPosition, containerAt, nodes, t],
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

  // —— 入口单选维护（§入口 hybrid）：设某节点为入口时清除其它所有节点的 isEntry ——
  // 传 null 表示取消所有显式入口（回退拓扑推导）。运行期 resolveStartExecutor 显式优先、拓扑兜底。
  const setEntryNode = useCallback((id: string | null) => {
    setNodes((nds) =>
      nds.map((n) => {
        const isEntry = n.id === id
        // 只改动 isEntry 字段，避免覆盖其它 data
        return { ...n, data: { ...n.data, isEntry } }
      }),
    )
  }, [])

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
      name: cap?.name ?? t('editor:untitled'),
      description: cap?.description,
      graph,
    })
    setSavedAt(Date.now())
  }, [capabilityId, nodes, edges, saveCap, capQ.data, t])

  // —— 运行编排（聊天化：composer 输入即任务，与首页 @能力 运行同一体系）——
  // 点运行按钮 → 切到「运行对话」tab；每次发送 = 重新开始一个新对话（清空上一场
  // 消息 + 新建 session）：能力运行无状态，turn 间不共享 executor cache。
  // 流事件同时驱动画布节点高亮 + 聊天气泡（applyOrchEvent 共享 reducer）。
  const openRunChat = useCallback(() => {
    if (nodes.length === 0) return
    switchRightTab('chat')
  }, [nodes.length, switchRightTab])

  const onRun = useCallback(async (input: string) => {
    const text = input.trim()
    if (running || nodes.length === 0 || !text) return
    setRunning(true)
    // 新对话：清空上一场消息，user 消息入流（与首页发送一致：先入气泡再请求）
    setChatMsgs([{ id: crypto.randomUUID(), role: 'user', text }])
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

    // 会话持久化：每次运行新建 session（capabilityId 关联，标记为能力试跑记录——
    // 不进主 Agent 会话列表，在本页「运行对话」历史下拉回看）；
    // 主进程在 orchestrate:run 内落用户输入 + 聚合输出。
    let sid: string | null = null
    if (capabilityId) {
      try {
        const s = await window.one.sessions
          .create({ title: text.slice(0, 20), capabilityId })
          .then(unwrap)
        sid = s.id
        // 刷新试跑记录下拉（新记录立即可见）
        void qc.invalidateQueries({ queryKey: ['sessions'] })
      } catch (e) {
        // session 创建失败不阻塞运行（仅不持久化）
        console.warn('[editor] 创建运行会话失败，本次不落库', e)
      }
    }

    const unsub = window.one.orchestrate.onStream((event: StreamEvent) => {
      // 1. 聊天气泡（共享 reducer：output 分泡 / 错误 / HITL 提问卡）
      setChatMsgs((prev) => applyOrchEvent(prev, event))
      // 2. 画布节点状态高亮
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
        case 'done':
        case 'failed':
          setRunning(false)
          setActiveNodeId(null)
          break
      }
    })

    try {
      await window.one.orchestrate.run({ graph, input: text, sessionId: sid ?? undefined }).then(unwrap)
      // 兜底复位：done 事件若晚于 unsub 到达，running 不能卡死
      setRunning(false)
      setActiveNodeId(null)
    } catch (e) {
      // IPC 层失败（未配置供应商等）：错误气泡（与首页错误呈现一致）
      setChatMsgs((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: e instanceof Error ? e.message : String(e),
          error: true,
        },
      ])
      setRunning(false)
      setActiveNodeId(null)
    } finally {
      unsub()
    }
  }, [nodes, edges, running, capabilityId, qc])

  // —— 选中节点 ——
  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null
  const cap = capQ.data as Capability | undefined

  // —— 生效入口计算（前端镜像 resolveStartExecutor：显式优先，拓扑兜底）——
  // 返回实际生效入口节点 id（顶层节点；sequential 容器作入口时指容器自身——徽章显示在用户操作对象上）。
  // 用于 Inspector 状态显示 + 节点徽章「入口/入口·推导」。
  const entryInfo = (() => {
    const topLevel = nodes.filter((n) => !n.parentId)
    const hasIncoming = new Set(edges.map((e) => e.target))
    const explicit = topLevel.filter((n) => (n.data as { isEntry?: boolean }).isEntry === true)
    if (explicit.length > 0) {
      return { id: explicit[0].id, explicit: true }
    }
    const topo = topLevel.filter((n) => !hasIncoming.has(n.id))
    const derived = topo[0] ?? nodes[0]
    return derived ? { id: derived.id, explicit: false } : null
  })()
  const effectiveEntryId = entryInfo?.id ?? null
  const hasExplicitEntry = entryInfo?.explicit ?? false

  // 派生显示节点：给生效入口节点注入 effectiveEntry 徽章标记（派生字段，不入库）。
  // 保存仍用原始 nodes state（onSaveNow 读 nodes），effectiveEntry 仅画布渲染用。
  const displayNodes = useMemo(
    () =>
      nodes.map((n) =>
        n.id === effectiveEntryId
          ? { ...n, data: { ...n.data, effectiveEntry: true, entryDerived: !hasExplicitEntry } }
          : n,
      ),
    [nodes, effectiveEntryId, hasExplicitEntry],
  )

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
                title={t(`editor:${c.descKey}`)}
              >
                <Icon size={14} style={{ flexShrink: 0 }} />
                <span className="rf-palette-item__label">{t(`editor:${c.labelKey}`)}</span>
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
                <RefreshCw size={14} className="animate-spin" /> {t('editor:save.saving')}
              </>
            ) : savedAt && Date.now() - savedAt < 3000 ? (
              <>
                <Check size={14} /> {t('editor:save.saved')}
              </>
            ) : (
              <>
                <Save size={14} /> {t('common:actions.save')}
              </>
            )}
          </Button>
          <Button
            onClick={openRunChat}
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
          nodes={displayNodes}
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

      {/* ── 右侧栏：属性 Inspector / 运行对话 tabs（左缘拖拽调宽）── */}
      <aside
        className="glass-panel"
        style={{
          width: asideW,
          flexShrink: 0,
          position: 'relative',
          borderRadius: 20,
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          overflow: 'hidden',
        }}
      >
        <div
          className="aside-resizer"
          onMouseDown={onAsideDragStart}
          title={t('editor:aside.resize')}
        />
        {/* tab 头 */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <button
            type="button"
            onClick={() => switchRightTab('inspector')}
            className={`editor-tab${rightTab === 'inspector' ? ' editor-tab--active' : ''}`}
          >
            <SlidersHorizontal size={13} /> {t('editor:tabs.inspector')}
          </button>
          <button
            type="button"
            onClick={() => switchRightTab('chat')}
            className={`editor-tab${rightTab === 'chat' ? ' editor-tab--active' : ''}`}
          >
            <MessageSquare size={13} /> {t('editor:tabs.chat')}
          </button>
          {running ? <Badge variant="brand">{t('editor:running')}</Badge> : null}
          {/* 试跑记录回看（本能力的运行会话，不进主 Agent 会话列表） */}
          {rightTab === 'chat' ? (
            <div style={{ marginLeft: 'auto', position: 'relative' }}>
              <button
                type="button"
                className="editor-tab"
                title={t('editor:runChat.history')}
                onClick={() => setHistoryOpen((o) => !o)}
              >
                <History size={13} />
              </button>
              {historyOpen ? (
                <>
                  <div
                    style={{ position: 'fixed', inset: 0, zIndex: 39 }}
                    onClick={() => setHistoryOpen(false)}
                  />
                  <div className="run-history glass-panel">
                    {runHistory.length === 0 ? (
                      <p className="run-history__empty">{t('editor:runChat.historyEmpty')}</p>
                    ) : (
                      runHistory.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          className="run-history__item"
                          onClick={() => {
                            setHistoryOpen(false)
                            void loadRunSession(s.id)
                          }}
                        >
                          <span className="run-history__title">{s.title}</span>
                          <span className="run-history__time">
                            {new Intl.DateTimeFormat(undefined, {
                              month: '2-digit',
                              day: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit',
                            }).format(s.updatedAt)}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </div>

        {rightTab === 'inspector' ? (
          <div style={{ display: 'grid', gap: 12, alignContent: 'start', overflow: 'auto', flex: 1, minHeight: 0 }}>
            {selectedNode ? (
              <NodeInspector
                node={selectedNode}
                nodes={nodes}
                skills={skills}
                agents={agents}
                onUpdate={updateNodeData}
                onSetEntry={setEntryNode}
                effectiveEntryId={effectiveEntryId}
                hasExplicitEntry={hasExplicitEntry}
                onDelete={onDeleteNode}
                t={t}
              />
            ) : (
              <p className="section-subtitle">{t('editor:inspector.hint')}</p>
            )}
          </div>
        ) : (
          <RunChatPanel
            messages={chatMsgs}
            speakerName={speakerName}
            running={running}
            onSend={(text) => void onRun(text)}
            onStop={() => void window.one.orchestrate.cancel()}
          />
        )}
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
  onSetEntry,
  effectiveEntryId,
  hasExplicitEntry,
  onDelete,
  t,
}: {
  node: Node
  nodes: Node[]
  skills: Array<{ id: string; name: string }>
  agents: Agent[]
  onUpdate: (id: string, patch: Record<string, unknown>) => void
  onSetEntry: (id: string | null) => void
  effectiveEntryId: string | null
  hasExplicitEntry: boolean
  onDelete: (id: string) => void
  t: (key: string, options?: Record<string, unknown>) => string
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
  const containerMeta = isAgent ? undefined : CONTAINER_TYPES.find((c) => c.type === data.kind)
  const containerTypeLabel = containerMeta ? t(`editor:${containerMeta.labelKey}`) : data.kind

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
          <label className="rf-inspector-label">{t('common:columns.name')}</label>
          <Input
            value={data.label ?? ''}
            onChange={(e) => onUpdate(node.id, { label: e.target.value })}
            style={{ marginTop: 4 }}
          />
        </div>

        {/* —— 入口设置（agent + 容器通用，单选语义；仅顶层节点可设）——
            勾选 → onSetEntry(node.id)（自动清其它入口）；取消 → onSetEntry(null) 回退拓扑推导。
            容器也可设入口：concurrent/groupchat/handoff 容器自身是 dispatcher/协调器作入口；
            sequential 容器作入口时运行期自动从首 participant 进入（对用户透明）。
            容器子节点（data.parentId）不显示：运行期 resolveStartExecutor 只认顶层
            isEntry，给 participant 设入口会被静默忽略（实测误导：用户给调研子节点
            设入口以为只跑调研，实际入口是并发容器整体）。 */}
        {!(data as { parentId?: string }).parentId ? (
          <div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={data.isEntry ?? false}
                onChange={(e) => onSetEntry(e.target.checked ? node.id : null)}
              />
              {t('editor:inspector.entry.set')}
            </label>
            {/* 生效入口状态提示 */}
            {effectiveEntryId === node.id ? (
              <p style={{ fontSize: '0.72rem', margin: '4px 0 0', color: 'var(--color-brand-500)' }}>
                {hasExplicitEntry
                  ? t('editor:inspector.entry.activeExplicit')
                  : t('editor:inspector.entry.activeDerived')}
              </p>
            ) : !hasExplicitEntry && effectiveEntryId ? (
              <p style={{ fontSize: '0.72rem', margin: '4px 0 0', color: 'var(--color-fg-3)' }}>
                {t('editor:inspector.entry.derivedHint', {
                  name:
                    (nodes.find((n) => n.id === effectiveEntryId)?.data as { label?: string })?.label ??
                    effectiveEntryId,
                })}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Agent 特有属性 */}
      {isAgent ? (
        <div className="surface-panel" style={{ borderRadius: 12, padding: 12, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <p className="rf-inspector-section" style={{ margin: 0 }}>{t('editor:inspector.nodeConfig')}</p>
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
                title={t('editor:inspector.refreshFromTemplateHint')}
              >
                <RefreshCw size={11} /> {t('editor:inspector.refreshFromTemplate')}
              </button>
            ) : null}
          </div>
          {data.sourceAgentId ? (
            <p style={{ fontSize: '0.7rem', color: 'var(--color-fg-3)', margin: 0 }}>
              {t('editor:inspector.sourceTemplate', { id: data.sourceAgentId })}
            </p>
          ) : null}
          <div>
            <label className="rf-inspector-label">{t('editor:capabilities.desc')}</label>
            <Input
              value={data.description ?? ''}
              onChange={(e) => onUpdate(node.id, { description: e.target.value })}
              placeholder={t('editor:inspector.descPlaceholder')}
              style={{ marginTop: 4 }}
            />
          </div>
          <div>
            <label className="rf-inspector-label">System Prompt</label>
            <textarea
              value={data.instructions ?? ''}
              onChange={(e) => onUpdate(node.id, { instructions: e.target.value })}
              placeholder={t('editor:inspector.promptPlaceholder')}
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
            <label className="rf-inspector-label">{t('editor:inspector.modelLabel')}</label>
            <Input
              value={data.model ?? ''}
              onChange={(e) => onUpdate(node.id, { model: e.target.value, modelId: e.target.value })}
              placeholder={t('editor:inspector.modelPlaceholder')}
              style={{ marginTop: 4 }}
            />
          </div>
          <div>
            <label className="rf-inspector-label">{t('editor:inspector.constraintsLabel')}</label>
            <Input
              value={data.outputConstraints ?? ''}
              onChange={(e) => onUpdate(node.id, { outputConstraints: e.target.value })}
              placeholder={t('editor:inspector.constraintsPlaceholder')}
              style={{ marginTop: 4 }}
            />
          </div>
          {/* 挂载技能 */}
          <div>
            <label className="rf-inspector-label">{t('editor:inspector.skillsLabel')}</label>
            {skills.length === 0 ? (
              <p style={{ fontSize: '0.75rem', color: 'var(--color-fg-3)', margin: '4px 0 0' }}>
                {t('editor:inspector.skillsEmpty')}
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
        </div>
      ) : null}

      {/* Container 特有属性 */}
      {!isAgent ? (
        <div className="surface-panel" style={{ borderRadius: 12, padding: 12, display: 'grid', gap: 8 }}>
          <p className="rf-inspector-section">{t('editor:inspector.containerConfig')}</p>
          <div>
            <label className="rf-inspector-label">{t('editor:inspector.typeLabel')}</label>
            <p style={{ fontSize: '0.8rem', margin: '4px 0 0', color: 'var(--color-fg-1)' }}>
              {containerTypeLabel}
            </p>
          </div>

          {/* 子节点列表 */}
          <div>
            <label className="rf-inspector-label">
              {t('editor:inspector.childAgents', { count: (data.participants ?? []).length })}
            </label>
            {(data.participants ?? []).length === 0 ? (
              <p style={{ fontSize: '0.75rem', color: 'var(--color-fg-3)', margin: '4px 0 0' }}>
                {t('editor:inspector.dropHint')}
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
                <label className="rf-inspector-label">{t('editor:inspector.selectorModeLabel')}</label>
                <select
                  value={data.selectorMode ?? 'round_robin'}
                  onChange={(e) => onUpdate(node.id, { selectorMode: e.target.value })}
                  style={selectStyle}
                >
                  <option value="round_robin">{t('editor:inspector.selectorRoundRobin')}</option>
                  <option value="manager">{t('editor:inspector.selectorManager')}</option>
                </select>
              </div>
              <div>
                <label className="rf-inspector-label">{t('editor:inspector.maxRounds')}</label>
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
              <label className="rf-inspector-label">{t('editor:inspector.startAgent')}</label>
              <select
                value={data.startAgent ?? ''}
                onChange={(e) => onUpdate(node.id, { startAgent: e.target.value })}
                style={selectStyle}
              >
                <option value="">{t('editor:inspector.startAgentAuto')}</option>
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
