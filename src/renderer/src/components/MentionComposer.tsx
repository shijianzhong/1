import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { Agent, Capability } from '@shared/types'

// —— @提及芯片输入框（首页主助手 @角色/@能力，§三之三 M）——
// contenteditable 承载文本 + 芯片（contenteditable=false span，data-mention 存元数据）。
// @ 触发下拉：本地过滤（角色/能力），↑↓ 导航，Enter/Tab 选中，Esc 关闭。
// 序列化（getText）：芯片还原为 @名字 纯文本，交后端 resolveMentions 正则接住。

export interface MentionTarget {
  kind: 'agent' | 'capability'
  id: string
  name: string
  description?: string
}

export interface MentionComposerHandle {
  /** 取当前输入纯文本（芯片已还原为 @名字） */
  getText: () => string
  /** 清空输入 */
  clear: () => void
  /** 聚焦 */
  focus: () => void
}

interface Props {
  agents: Agent[]
  capabilities: Capability[]
  disabled?: boolean
  placeholder?: string
  onSend: (text: string) => void
}

/** 把 Agent/Capability 归一为 MentionTarget 列表 */
function toTargets(agents: Agent[], capabilities: Capability[]): MentionTarget[] {
  return [
    ...agents.map((a) => ({
      kind: 'agent' as const,
      id: a.id,
      name: a.name,
      description: a.description,
    })),
    ...capabilities.map((c) => ({
      kind: 'capability' as const,
      id: c.id,
      name: c.name,
      description: c.description,
    })),
  ]
}

export const MentionComposer = forwardRef<MentionComposerHandle, Props>(
  function MentionComposer({ agents, capabilities, disabled, placeholder, onSend }, ref) {
    const { t } = useTranslation(['home', 'common'])
    const editorRef = useRef<HTMLDivElement>(null)
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    const [activeIdx, setActiveIdx] = useState(0)
    /** @ 触发位置（文本节点内的 @ 偏移），用于选中后替换 @query 段 */
    const mentionAnchorRef = useRef<{ node: Text; offset: number } | null>(null)

    const targets = toTargets(agents, capabilities)
    const filtered = query
      ? targets.filter((tg) => tg.name.toLowerCase().includes(query.toLowerCase()))
      : targets

    // 序列化：遍历 DOM，芯片 span → @名字，文本节点原样拼接
    const getText = useCallback((): string => {
      const el = editorRef.current
      if (!el) return ''
      let out = ''
      const walk = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          out += node.textContent
          return
        }
        if (node.nodeType === Node.ELEMENT_NODE) {
          const elem = node as HTMLElement
          if (elem.dataset.mention) {
            out += `@${elem.dataset.mention}`
            return
          }
          if (elem.tagName === 'BR') {
            out += '\n'
            return
          }
          node.childNodes.forEach(walk)
          return
        }
      }
      el.childNodes.forEach(walk)
      return out.trim()
    }, [])

    useImperativeHandle(ref, () => ({
      getText,
      clear: () => {
        if (editorRef.current) editorRef.current.innerHTML = ''
      },
      focus: () => editorRef.current?.focus(),
    }))

    // 选中目标：替换 @query 段为芯片
    const insertChip = useCallback(
      (target: MentionTarget) => {
        const anchor = mentionAnchorRef.current
        const el = editorRef.current
        if (!el) return

        // 构造芯片（contenteditable=false 防编辑破坏结构）
        const chip = document.createElement('span')
        chip.className = `mention-chip mention-chip--${target.kind}`
        chip.contentEditable = 'false'
        chip.dataset.mention = target.name
        chip.dataset.kind = target.kind
        chip.dataset.id = target.id
        chip.textContent = `@${target.name}`

        if (anchor) {
          // 替换 @query 文本段：anchor 节点从 @ 处到当前光标（@ + query 长度）
          const node = anchor.node
          const startOffset = anchor.offset
          const before = node.textContent?.slice(0, startOffset) ?? ''
          // query 长度 = 当前 query 字符串长（@ 后已键入部分）
          const after = node.textContent?.slice(startOffset + 1 + query.length) ?? ''
          const parent = node.parentNode
          if (parent) {
            const beforeNode = document.createTextNode(before)
            const afterNode = document.createTextNode(after ? ` ${after}` : ' ') // 芯片后留空格
            parent.insertBefore(beforeNode, node)
            parent.insertBefore(chip, node)
            parent.insertBefore(afterNode, node)
            parent.removeChild(node)
            // 光标移到芯片后
            const range = document.createRange()
            range.setStart(afterNode, afterNode.textContent?.length ?? 0)
            range.collapse(true)
            const sel = window.getSelection()
            sel?.removeAllRanges()
            sel?.addRange(range)
          }
        } else {
          // 无 anchor（兜底）：追加到末尾
          el.appendChild(chip)
          el.appendChild(document.createTextNode(' '))
        }

        mentionAnchorRef.current = null
        setOpen(false)
        setQuery('')
        setActiveIdx(0)
        el.focus()
      },
      [query],
    )

    // 监听输入：识别 @ 触发与 query 更新
    const handleInput = useCallback(() => {
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return
      const range = sel.getRangeAt(0)
      const node = range.startContainer
      if (node.nodeType !== Node.TEXT_NODE) {
        // 光标在元素边界（如刚删完芯片）：关闭下拉
        setOpen(false)
        return
      }
      const text = node.textContent ?? ''
      const cursor = range.startOffset
      const before = text.slice(0, cursor)
      // 找光标前最后一个 @（前面是空白/行首才算触发，避免邮箱类误判）
      const atIdx = before.lastIndexOf('@')
      if (atIdx >= 0) {
        const charBefore = before[atIdx - 1]
        const isTrigger =
          atIdx === 0 || charBefore === ' ' || charBefore === ' ' || charBefore === '\n'
        const queryText = before.slice(atIdx + 1)
        // @ 后不能含空白（含空白说明已离开提及上下文）
        if (isTrigger && !/\s/.test(queryText)) {
          mentionAnchorRef.current = { node: node as Text, offset: atIdx }
          setQuery(queryText)
          setOpen(true)
          setActiveIdx(0)
          return
        }
      }
      mentionAnchorRef.current = null
      setOpen(false)
    }, [])

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (open && filtered.length > 0) {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActiveIdx((i) => (i + 1) % filtered.length)
            return
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActiveIdx((i) => (i - 1 + filtered.length) % filtered.length)
            return
          }
          if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            insertChip(filtered[activeIdx])
            return
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            setOpen(false)
            return
          }
        }
        // Enter 发送（Shift+Enter 换行）
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          const text = getText()
          if (text) onSend(text)
        }
      },
      [open, filtered, activeIdx, insertChip, getText, onSend],
    )

    // Backspace 在芯片后 → 整块删除芯片（contenteditable 默认会把光标吸进芯片）
    const handleKeyUp = useCallback((e: React.KeyboardEvent) => {
      if (e.key !== 'Backspace') return
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return
      const range = sel.getRangeAt(0)
      const node = range.startContainer
      // 光标在元素边界且前一个兄弟是芯片 → 删芯片
      if (node.nodeType === Node.ELEMENT_NODE) {
        const elem = node as HTMLElement
        const prev = elem.childNodes[range.startOffset - 1] as HTMLElement | undefined
        if (prev?.dataset?.mention) prev.remove()
      }
    }, [])

    // 点击外部关闭下拉
    useEffect(() => {
      if (!open) return
      const close = () => setOpen(false)
      document.addEventListener('mousedown', close)
      return () => document.removeEventListener('mousedown', close)
    }, [open])

    return (
      <div className="mention-composer">
        <div
          ref={editorRef}
          className="mention-composer__editor"
          contentEditable={!disabled}
          data-placeholder={placeholder ?? t('home:composerPlaceholder')}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onMouseDown={(e) => e.stopPropagation()}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
        />
        {open && filtered.length > 0 ? (
          <div
            className="mention-composer__dropdown glass-panel"
            onMouseDown={(e) => e.stopPropagation()}
          >
            {filtered.slice(0, 8).map((tg, i) => (
              <button
                key={`${tg.kind}:${tg.id}`}
                type="button"
                className={`mention-composer__option ${i === activeIdx ? 'is-active' : ''}`}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => insertChip(tg)}
              >
                <span className={`mention-composer__badge mention-composer__badge--${tg.kind}`}>
                  {tg.kind === 'agent' ? t('home:mention.agent') : t('home:mention.capability')}
                </span>
                <span className="mention-composer__name">@{tg.name}</span>
                {tg.description ? (
                  <span className="mention-composer__desc">{tg.description}</span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    )
  },
)
