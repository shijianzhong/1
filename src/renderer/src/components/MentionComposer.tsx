import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { Agent, Capability, SkillMeta } from '@shared/types'
import { formatMentionDisplay, type MentionKind } from '@shared/mentions'

// —— @提及芯片输入框（首页主助手 @角色/@能力/@技能，§三之三 M）——
// contenteditable 承载文本 + 芯片（contenteditable=false span，data-kind/data-id 存稳定引用）。
// @ 触发分组下拉：角色 / 能力 / 技能三组，手风琴折叠（点击标题展开/收起），
// 搜索实时过滤（有 query 时自动展开所有匹配组），↑↓ 跨组导航（仅展开组），
// Enter/Tab 选中，Esc 关闭，近期用过优先排前（localStorage 持久）。
// 序列化：getText → `@名字`（对话好看）；getMentions → {kind,id} 旁路给主进程稳定解析。

export interface MentionTarget {
  kind: MentionKind
  id: string
  name: string
  description?: string
}

export interface MentionComposerHandle {
  /** 取当前输入纯文本（芯片还原为 @名字，供展示/落库） */
  getText: () => string
  /** 取芯片稳定引用（kind+id），与 getText 配套发给 home:chat */
  getMentions: () => Array<{ kind: MentionKind; id: string; name: string }>
  /** 清空输入 */
  clear: () => void
  /** 聚焦 */
  focus: () => void
  /** 在光标位置插入文本（用于 SelectionActions 引用插入） */
  insertText: (text: string) => void
}

interface Props {
  agents: Agent[]
  capabilities: Capability[]
  skills: SkillMeta[]
  disabled?: boolean
  placeholder?: string
  onSend: (text: string) => void
}

const RECENT_KEY = 'one.home.recentMentions'
const MAX_RECENT = 5
/** 展开组内最大渲染条目数（防极端数量卡渲染；折叠组不渲染） */
const MAX_ITEMS_PER_GROUP = 50

/** 读近期提及 id 列表（localStorage，新→旧） */
function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** 记录一次提及（置顶，去重，截断） */
function pushRecent(id: string): void {
  try {
    const next = [id, ...readRecent().filter((x) => x !== id)].slice(0, MAX_RECENT * 3)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* localStorage 不可用时静默 */
  }
}

interface MentionGroup {
  kind: MentionTarget['kind']
  items: MentionTarget[]
}

/** 组装分组 + 搜索过滤 + 近期优先排序（纯函数，可测） */
export function buildMentionGroups(
  agents: Agent[],
  capabilities: Capability[],
  skills: SkillMeta[],
  query: string,
  recentIds: string[],
): MentionGroup[] {
  const q = query.trim().toLowerCase()
  const match = (t: { name: string; description?: string }) =>
    !q ||
    t.name.toLowerCase().includes(q) ||
    (t.description?.toLowerCase().includes(q) ?? false)

  const toTarget = (
    kind: MentionTarget['kind'],
    x: { id: string; name: string; description?: string },
  ): MentionTarget => ({ kind, id: x.id, name: x.name, description: x.description })

  // 近期优先：recentIds 顺序即优先级；非近期按原名排
  const rank = (t: MentionTarget): number => {
    const idx = recentIds.indexOf(`${t.kind}:${t.id}`)
    return idx < 0 ? recentIds.length + 1 : idx
  }
  const sortByRecent = (list: MentionTarget[]): MentionTarget[] =>
    [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'zh-CN'))

  const groups: MentionGroup[] = [
    {
      kind: 'agent',
      items: sortByRecent(agents.filter(match).map((a) => toTarget('agent', a))),
    },
    {
      kind: 'capability',
      items: sortByRecent(
        capabilities.filter(match).map((c) => toTarget('capability', c)),
      ),
    },
    {
      kind: 'skill',
      items: sortByRecent(skills.filter(match).map((s) => toTarget('skill', s))),
    },
  ]
  return groups.filter((g) => g.items.length > 0)
}

/** 拍平**展开**分组为线性列表（键盘 ↑↓ 跨组导航用）；折叠组的条目不参与导航 */
function flatten(groups: MentionGroup[], expanded: Set<string>): MentionTarget[] {
  return groups
    .filter((g) => expanded.has(g.kind))
    .flatMap((g) => g.items.slice(0, MAX_ITEMS_PER_GROUP))
}

export const MentionComposer = forwardRef<MentionComposerHandle, Props>(
  function MentionComposer(
    { agents, capabilities, skills, disabled, placeholder, onSend },
    ref,
  ) {
    const { t } = useTranslation(['home', 'common'])
    const editorRef = useRef<HTMLDivElement>(null)
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    const [activeIdx, setActiveIdx] = useState(0)
    const [recentIds, setRecentIds] = useState<string[]>(readRecent)
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
    const mentionAnchorRef = useRef<{ node: Text; offset: number } | null>(null)

    const groups = useMemo(
      () => buildMentionGroups(agents, capabilities, skills, query, recentIds),
      [agents, capabilities, skills, query, recentIds],
    )

    // 搜索时自动展开所有匹配组；无搜索时默认展开第一个有内容的组
    useEffect(() => {
      if (!open) return
      const q = query.trim()
      if (q) {
        // 有搜索词：展开所有有匹配的组
        setExpandedGroups(new Set(groups.map((g) => g.kind)))
      } else {
        // 无搜索词：只展开第一个组
        const firstKind = groups[0]?.kind
        setExpandedGroups(firstKind ? new Set([firstKind]) : new Set())
      }
    }, [query, open, groups])
    const flat = useMemo(() => flatten(groups, expandedGroups), [groups, expandedGroups])

    // 点击组标题：切换展开/折叠
    const toggleGroup = useCallback((kind: string) => {
      setExpandedGroups((prev) => {
        const next = new Set(prev)
        if (next.has(kind)) next.delete(kind)
        else next.add(kind)
        return next
      })
      setActiveIdx(0)
    }, [])

    // 序列化展示文本：芯片 → @名字（对话记录/落库好看）
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
            out += formatMentionDisplay(elem.dataset.mention)
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

    // 芯片稳定引用（旁路，不进正文）
    const getMentions = useCallback((): Array<{ kind: MentionKind; id: string; name: string }> => {
      const el = editorRef.current
      if (!el) return []
      const out: Array<{ kind: MentionKind; id: string; name: string }> = []
      const seen = new Set<string>()
      const walk = (node: Node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) {
          node.childNodes.forEach(walk)
          return
        }
        const elem = node as HTMLElement
        const kind = elem.dataset.kind as MentionKind | undefined
        const id = elem.dataset.id
        const name = elem.dataset.mention
        if (kind && id && name) {
          const key = `${kind}:${id}`
          if (!seen.has(key)) {
            seen.add(key)
            out.push({ kind, id, name })
          }
          return
        }
        node.childNodes.forEach(walk)
      }
      el.childNodes.forEach(walk)
      return out
    }, [])

    useImperativeHandle(ref, () => ({
      getText,
      getMentions,
      clear: () => {
        if (editorRef.current) editorRef.current.innerHTML = ''
      },
      focus: () => editorRef.current?.focus(),
      insertText: (text: string) => {
        const el = editorRef.current
        if (!el) return
        el.focus()
        // 优先用 execCommand 在光标处插入（Electron Chromium 支持）
        if (document.execCommand('insertText', false, text)) return
        // fallback：直接追加文本节点
        el.appendChild(document.createTextNode(text))
      },
    }))

    // 选中目标：替换 @query 段为芯片
    const insertChip = useCallback(
      (target: MentionTarget) => {
        const anchor = mentionAnchorRef.current
        const el = editorRef.current
        if (!el) return

        const chip = document.createElement('span')
        chip.className = `mention-chip mention-chip--${target.kind}`
        chip.contentEditable = 'false'
        chip.dataset.kind = target.kind
        chip.dataset.id = target.id
        chip.dataset.mention = target.name // 展示名；序列化优先 kind+id
        chip.textContent = `@${target.name}`

        if (anchor) {
          const node = anchor.node
          const startOffset = anchor.offset
          const before = node.textContent?.slice(0, startOffset) ?? ''
          const after = node.textContent?.slice(startOffset + 1 + query.length) ?? ''
          const parent = node.parentNode
          if (parent) {
            const beforeNode = document.createTextNode(before)
            const afterNode = document.createTextNode(after ? ` ${after}` : ' ')
            parent.insertBefore(beforeNode, node)
            parent.insertBefore(chip, node)
            parent.insertBefore(afterNode, node)
            parent.removeChild(node)
            const range = document.createRange()
            range.setStart(afterNode, afterNode.textContent?.length ?? 0)
            range.collapse(true)
            const sel = window.getSelection()
            sel?.removeAllRanges()
            sel?.addRange(range)
          }
        } else {
          el.appendChild(chip)
          el.appendChild(document.createTextNode(' '))
        }

        // 记近期提及
        pushRecent(`${target.kind}:${target.id}`)
        setRecentIds(readRecent())

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
        setOpen(false)
        return
      }
      const text = node.textContent ?? ''
      const cursor = range.startOffset
      const before = text.slice(0, cursor)
      const atIdx = before.lastIndexOf('@')
      if (atIdx >= 0) {
        const charBefore = before[atIdx - 1]
        const isTrigger =
          atIdx === 0 || charBefore === ' ' || charBefore === ' ' || charBefore === '\n'
        const queryText = before.slice(atIdx + 1)
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
        // IME 合成态（中文输入法打字中）：Enter 用于确认候选词，不触发发送/选中
        if (e.nativeEvent.isComposing || e.keyCode === 229) return
        if (open && flat.length > 0) {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActiveIdx((i) => (i + 1) % flat.length)
            return
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActiveIdx((i) => (i - 1 + flat.length) % flat.length)
            return
          }
          if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            const target = flat[activeIdx]
            if (target) insertChip(target)
            return
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            setOpen(false)
            return
          }
        }
        // 下拉打开但无展开项（全折叠 / 无搜索结果）：Enter/Tab/Escape 关闭下拉，不发送
        if (open && flat.length === 0) {
          if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape') {
            e.preventDefault()
            setOpen(false)
            return
          }
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          const text = getText()
          if (text) onSend(text)
        }
      },
      [open, flat, activeIdx, insertChip, getText, onSend],
    )

    // Backspace 在芯片后 → 整块删除芯片
    const handleKeyUp = useCallback((e: React.KeyboardEvent) => {
      if (e.key !== 'Backspace') return
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return
      const range = sel.getRangeAt(0)
      const node = range.startContainer
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

    // 键盘 active 项变化时滚入可视区
    const listRef = useRef<HTMLDivElement>(null)
    useEffect(() => {
      const el = listRef.current?.querySelector('.is-active')
      el?.scrollIntoView({ block: 'nearest' })
    }, [activeIdx])

    const kindLabel = (kind: MentionTarget['kind']): string =>
      kind === 'agent'
        ? t('home:mention.agent')
        : kind === 'capability'
          ? t('home:mention.capability')
          : t('home:mention.skill')

    // 渲染分组：跨组线性索引用于 active 高亮
    let linearIdx = -1

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
        {open && groups.length > 0 ? (
          <div
            ref={listRef}
            className="mention-composer__dropdown"
            onMouseDown={(e) => e.stopPropagation()}
            onMouseLeave={() => setActiveIdx(-1)}
          >
            {groups.map((g) => {
              const isExpanded = expandedGroups.has(g.kind)
              return (
                <div key={g.kind} className="mention-composer__group">
                  <button
                    type="button"
                    className={`mention-composer__group-title ${isExpanded ? 'is-expanded' : ''}`}
                    onClick={() => toggleGroup(g.kind)}
                  >
                    <span className="mention-composer__group-label">{kindLabel(g.kind)}</span>
                    <span className="mention-composer__group-count">{g.items.length}</span>
                    <svg
                      className="mention-composer__chevron"
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      fill="none"
                    >
                      <path
                        d="M3 4.5L6 7.5L9 4.5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  {isExpanded &&
                    g.items.slice(0, MAX_ITEMS_PER_GROUP).map((tg) => {
                      linearIdx += 1
                      const idx = linearIdx
                      return (
                        <button
                          key={`${tg.kind}:${tg.id}`}
                          type="button"
                          className={`mention-composer__option ${idx === activeIdx ? 'is-active' : ''}`}
                          onMouseEnter={() => setActiveIdx(idx)}
                          onClick={() => insertChip(tg)}
                        >
                          <span className="mention-composer__name">{tg.name}</span>
                          {tg.description ? (
                            <span className="mention-composer__desc">{tg.description}</span>
                          ) : null}
                        </button>
                      )
                    })}
                </div>
              )
            })}
            {query && groups.length === 0 ? (
              <div className="mention-composer__empty">{t('home:mention.empty')}</div>
            ) : null}
          </div>
        ) : null}
        {open && groups.length === 0 ? (
          <div className="mention-composer__dropdown">
            <div className="mention-composer__empty">{t('home:mention.empty')}</div>
          </div>
        ) : null}
      </div>
    )
  },
)
