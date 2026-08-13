import { useEffect, useRef, useState, useCallback } from 'react'
import type { ChatMessage } from '@renderer/components/orchestra/types'

// —— 长内容定位轨道（Scroll Spy）——
// 右侧短横线集群：每条消息一根浅灰短横，紧凑排列在轨道中央；
// 深色短横标记当前阅读位置，随滚动在集群中移动；
// 点击短横可跳转到对应消息。

type SegType = 'user' | 'assistant' | 'tool' | 'thinking' | 'create' | 'error' | 'action'

// 段尺寸常量
const SEG_W = 10      // 短横宽度
const SEG_H = 3       // 短横高度
const SEG_GAP = 7     // 段间距
const SEG_STEP = SEG_H + SEG_GAP  // 10px 步进

interface Segment {
  id: string
  type: SegType
  top: number  // px within track（绝对定位）
}

function classifyMessage(msg: ChatMessage): SegType {
  if (msg.role === 'user') return 'user'
  if (msg.error || msg.proposalError) return 'error'
  if (msg.draft || msg.createNotice) return 'create'
  if (msg.askUser || msg.approval) return 'action'
  if (msg.toolCalls?.length) return 'tool'
  if (msg.thinking) return 'thinking'
  return 'assistant'
}

interface ScrollSpyProps {
  messages: ChatMessage[]
  containerRef: React.RefObject<HTMLDivElement | null>
}

export function ScrollSpy({ messages, containerRef }: ScrollSpyProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [segments, setSegments] = useState<Segment[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const rafRef = useRef(0)
  const hasSegmentsRef = useRef(false)
  // 起始 Y（集群垂直居中）
  const startYRef = useRef(0)

  // —— 段映射：等高短横紧凑排列，垂直居中于轨道 ——
  const updateSegments = useCallback(() => {
    const container = containerRef.current
    if (!container) return

    const { scrollHeight, clientHeight } = container
    if (scrollHeight <= clientHeight) {
      if (hasSegmentsRef.current) {
        setSegments([])
        hasSegmentsRef.current = false
      }
      return
    }

    const msgEls = container.querySelectorAll<HTMLElement>(':scope > .message')
    if (msgEls.length === 0) {
      if (hasSegmentsRef.current) {
        setSegments([])
        hasSegmentsRef.current = false
      }
      return
    }

    const count = Math.min(msgEls.length, messages.length)
    const trackHeight = clientHeight
    const totalSegHeight = count * SEG_STEP - SEG_GAP
    const startY = Math.max(0, (trackHeight - totalSegHeight) / 2)
    startYRef.current = startY

    const segs: Segment[] = []
    for (let i = 0; i < count; i++) {
      segs.push({
        id: messages[i].id,
        type: classifyMessage(messages[i]),
        top: startY + i * SEG_STEP,
      })
    }
    setSegments(segs)
    hasSegmentsRef.current = true

    // 同步当前活跃段
    updateActiveIndex(container, msgEls, count)
  }, [messages, containerRef])

  // 找到当前可视区顶部对应的消息索引
  const updateActiveIndex = (
    container: HTMLElement,
    msgEls: NodeListOf<HTMLElement>,
    count: number,
  ) => {
    const scrollTop = container.scrollTop
    let active = 0
    for (let i = 0; i < count; i++) {
      // 第一条底部超过 scrollTop 的消息即为当前活跃
      if (msgEls[i].offsetTop + msgEls[i].offsetHeight > scrollTop + 4) {
        active = i
        break
      }
      active = i
    }
    setActiveIndex(active)
  }

  // messages 变化或容器尺寸变化 → 重新计算段（rAF 防抖）
  useEffect(() => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(updateSegments)

    const container = containerRef.current
    if (!container) return

    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(updateSegments)
    })
    ro.observe(container)

    return () => {
      cancelAnimationFrame(rafRef.current)
      ro.disconnect()
    }
  }, [messages, updateSegments, containerRef])

  // 滚动 → 仅更新活跃段索引（高频，不做段重算）
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const onScroll = () => {
      if (!hasSegmentsRef.current) return
      const msgEls = container.querySelectorAll<HTMLElement>(':scope > .message')
      if (msgEls.length === 0) return
      updateActiveIndex(container, msgEls, msgEls.length)
    }

    container.addEventListener('scroll', onScroll, { passive: true })
    return () => container.removeEventListener('scroll', onScroll)
  }, [containerRef])

  // 点击段 → 跳转到对应消息
  const handleClick = (msgId: string): void => {
    const container = containerRef.current
    if (!container) return
    const msgEls = container.querySelectorAll<HTMLElement>(':scope > .message')
    const idx = messages.findIndex((m) => m.id === msgId)
    if (idx >= 0 && idx < msgEls.length) {
      msgEls[idx].scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  return (
    <div
      className={`scroll-spy${segments.length === 0 ? ' scroll-spy--empty' : ''}`}
      ref={trackRef}
    >
      {segments.map((seg, i) => (
        <div
          key={seg.id}
          className={`scroll-spy__segment scroll-spy__segment--${seg.type}${i === activeIndex ? ' scroll-spy__segment--active' : ''}`}
          style={{ top: seg.top }}
          onClick={() => handleClick(seg.id)}
        />
      ))}
    </div>
  )
}
