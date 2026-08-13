import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check, Quote, PenLine, Lightbulb, MessageCircle } from 'lucide-react'

export type SelectionAction = 'copy' | 'quote' | 'rewrite' | 'explain' | 'followup'

interface SelectionToolbarProps {
  /** 选区限定容器（chat-messages 滚动区） */
  containerRef: React.RefObject<HTMLDivElement | null>
  /** 引用选中文本到输入框 */
  onQuote: (text: string) => void
  /** 以选中文本为上下文发送消息 */
  onAsk: (action: 'rewrite' | 'explain' | 'followup', text: string) => void
}

/**
 * 选中文本浮动操作条：在 AI 回复气泡内选中文本后出现。
 *
 * 监听 mouseup / selectionchange，判定选区是否在 .message__bubble--assistant 内。
 * 操作：复制 / 引用 / 重写 / 解释 / 追问。
 */
export function SelectionToolbar({ containerRef, onQuote, onAsk }: SelectionToolbarProps) {
  const { t } = useTranslation(['common'])
  const [visible, setVisible] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [copied, setCopied] = useState(false)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const hideTimerRef = useRef<number | null>(null)

  const getSelectedText = useCallback((): { text: string; inAssistant: boolean } => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return { text: '', inAssistant: false }
    const text = sel.toString().trim()
    if (!text) return { text: '', inAssistant: false }

    // 判定选区是否在 assistant 气泡内
    const range = sel.getRangeAt(0)
    let node: Node | null = range.commonAncestorContainer
    while (node && node !== document.body) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement
        if (el.classList?.contains('message__bubble--assistant')) {
          return { text, inAssistant: true }
        }
      }
      node = node.parentNode
    }
    return { text, inAssistant: false }
  }, [])

  const updatePosition = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setVisible(false)
      return
    }
    const { text, inAssistant } = getSelectedText()
    if (!text || !inAssistant) {
      setVisible(false)
      return
    }

    const rect = sel.getRangeAt(0).getBoundingClientRect()
    const containerRect = containerRef.current?.getBoundingClientRect()
    // 相对容器坐标
    const x = rect.left - (containerRect?.left ?? 0) + rect.width / 2
    const y = rect.top - (containerRect?.top ?? 0) - 8
    setPos({ x, y })
    setVisible(true)
  }, [getSelectedText, containerRef])

  const handleSelectionChange = useCallback(() => {
    // selectionchange 在鼠标拖选过程中频繁触发，用 rAF 节流
    cancelAnimationFrame(hideTimerRef.current ?? 0)
    hideTimerRef.current = requestAnimationFrame(() => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) {
        setVisible(false)
        return
      }
      updatePosition()
    })
  }, [updatePosition])

  useEffect(() => {
    document.addEventListener('selectionchange', handleSelectionChange)
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange)
      if (hideTimerRef.current) cancelAnimationFrame(hideTimerRef.current)
    }
  }, [handleSelectionChange])

  // 滚动时隐藏
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onScroll = () => setVisible(false)
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => container.removeEventListener('scroll', onScroll)
  }, [containerRef])

  const handleCopy = () => {
    const { text } = getSelectedText()
    if (!text) return
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const handleQuote = () => {
    const { text } = getSelectedText()
    if (!text) return
    onQuote(text)
    setVisible(false)
    window.getSelection()?.removeAllRanges()
  }

  const handleAsk = (action: 'rewrite' | 'explain' | 'followup') => {
    const { text } = getSelectedText()
    if (!text) return
    onAsk(action, text)
    setVisible(false)
    window.getSelection()?.removeAllRanges()
  }

  if (!visible) return null

  const buttons = [
    { key: 'copy', icon: copied ? Check : Copy, label: t('common:selection.copy'), onClick: handleCopy },
    { key: 'quote', icon: Quote, label: t('common:selection.quote'), onClick: handleQuote },
    { key: 'rewrite', icon: PenLine, label: t('common:selection.rewrite'), onClick: () => handleAsk('rewrite') },
    { key: 'explain', icon: Lightbulb, label: t('common:selection.explain'), onClick: () => handleAsk('explain') },
    { key: 'followup', icon: MessageCircle, label: t('common:selection.followup'), onClick: () => handleAsk('followup') },
  ] as const

  return (
    <div
      ref={toolbarRef}
      className="selection-toolbar"
      style={{
        left: pos.x,
        top: pos.y,
        transform: 'translate(-50%, -100%)',
      }}
      onMouseDown={(e) => e.preventDefault()} // 防止选区丢失
    >
      {buttons.map((btn) => {
        const Icon = btn.icon
        return (
          <button
            key={btn.key}
            type="button"
            className="selection-toolbar__btn"
            title={btn.label}
            onClick={btn.onClick}
          >
            <Icon size={14} />
          </button>
        )
      })}
    </div>
  )
}
