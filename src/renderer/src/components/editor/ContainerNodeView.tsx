import { memo, useCallback, useRef } from 'react'
import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { Boxes, GitBranch, Users, Cable, Wrench } from 'lucide-react'
import type { NodeType } from '@shared/types'
import type { AgentNodeStatus } from './AgentNodeView'

// —— 容器节点视觉（借鉴 Proton ContainerNodeView）——
// 虚线边框、淡色底、提示「把 agent 拖到此容器内」。
// 容器是 ReactFlow parent 节点，agent 是 child（parentId + extent: parent）。
// 选中时右下角显示手动 resize 手柄（pointer events 直改 DOM，松手提交 state）。

export interface ContainerNodeData {
  label: string
  kind: NodeType // 'sequential' | 'concurrent' | 'groupchat' | 'handoff' | 'magentic'
  status?: AgentNodeStatus
  dropHover?: boolean
  /** 子节点 id 列表（participants） */
  participants?: string[]
  /** GroupChat 特有 */
  selectorMode?: 'round_robin' | 'manager'
  maxRounds?: number
  /** Handoff 特有 */
  startAgent?: string
  [key: string]: unknown
}

const CONTAINER_META: Record<
  string,
  { label: string; icon: typeof Boxes }
> = {
  sequential: { label: '顺序 Sequential', icon: GitBranch },
  concurrent: { label: '并发 Concurrent', icon: Boxes },
  groupchat: { label: '群聊 GroupChat', icon: Users },
  handoff: { label: '转交 Handoff', icon: Cable },
  magentic: { label: 'Magentic', icon: Wrench },
}

const MIN_W = 240
const MIN_H = 140

function ContainerNodeViewImpl({ id, data, selected }: NodeProps) {
  const { setNodes } = useReactFlow()
  const nodeRef = useRef<HTMLDivElement>(null)
  const resizing = useRef<{
    startX: number
    startY: number
    startW: number
    startH: number
    curW: number
    curH: number
  } | null>(null)

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const nodeEl = nodeRef.current?.closest('.react-flow__node') as HTMLElement | null
      if (!nodeEl) return

      resizing.current = {
        startX: e.clientX,
        startY: e.clientY,
        startW: nodeEl.offsetWidth,
        startH: nodeEl.offsetHeight,
        curW: nodeEl.offsetWidth,
        curH: nodeEl.offsetHeight,
      }

      const onPointerMove = (ev: PointerEvent) => {
        if (!resizing.current) return
        const r = resizing.current
        const dx = ev.clientX - r.startX
        const dy = ev.clientY - r.startY
        const newW = Math.max(MIN_W, r.startW + dx)
        const newH = Math.max(MIN_H, r.startH + dy)
        r.curW = newW
        r.curH = newH
        nodeEl.style.width = `${newW}px`
        nodeEl.style.height = `${newH}px`
      }

      const onPointerUp = () => {
        if (resizing.current) {
          const r = resizing.current
          // 提交最终尺寸到 ReactFlow 节点 state
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id ? { ...n, width: r.curW, height: r.curH } : n,
            ),
          )
          resizing.current = null
        }
        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('pointerup', onPointerUp)
      }

      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', onPointerUp)
    },
    [id, setNodes],
  )

  const d = data as ContainerNodeData
  const status = d.status ?? 'idle'
  const meta = CONTAINER_META[d.kind] ?? CONTAINER_META.sequential
  const Icon = meta.icon
  const childCount = d.participants?.length ?? 0

  return (
    <div
      ref={nodeRef}
      className={`rf-container-node rf-status--${status}${selected ? ' rf-node--selected' : ''}${d.dropHover ? ' rf-container-node--drop-hover' : ''}`}
      style={{
        width: '100%',
        height: '100%',
        minWidth: MIN_W,
        minHeight: MIN_H,
        position: 'relative',
      }}
    >
      <Handle type="target" position={Position.Left} className="rf-handle" />

      <div className="rf-container-node__header">
        <span className="rf-container-node__icon">
          <Icon size={14} />
        </span>
        <span className="rf-container-node__title">{meta.label}</span>
      </div>

      <div className="rf-container-node__body">
        <p className="rf-container-node__hint">
          {childCount > 0
            ? `${childCount} 个 Agent`
            : '把 Agent 拖到此容器内'}
        </p>
      </div>

      <Handle type="source" position={Position.Right} className="rf-handle" />

      {/* 手动 resize 手柄（选中时显示，右下角） */}
      {selected && (
        <div
          onPointerDown={onPointerDown}
          title="拖拽调整大小"
          style={{
            position: 'absolute',
            right: 2,
            bottom: 2,
            width: 14,
            height: 14,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'nwse-resize',
            zIndex: 9999,
            pointerEvents: 'all',
            color: 'var(--color-fg-3)',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ opacity: 0.5 }}>
            <line x1="1" y1="13" x2="13" y2="1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="5" y1="13" x2="13" y2="5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="9" y1="13" x2="13" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
      )}
    </div>
  )
}

export const ContainerNodeView = memo(ContainerNodeViewImpl)
