import { useCallback, useEffect, useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { motion } from 'framer-motion'
import { useTranslation } from 'react-i18next'
import { unwrap } from '@renderer/api/client'
import { IpcError } from '@renderer/api/client'
import { Markdown } from '@renderer/components/Markdown'
import { MentionComposer, type MentionComposerHandle } from '@renderer/components/MentionComposer'
import { CreateConfirmCard, type CardStatus } from '@renderer/components/CreateConfirmCard'
import { useAgents, useCapabilities, useSkills } from '@renderer/api/hooks'
import { useChatStore } from '@renderer/store/chat'
import type { CreateDraft, SessionMessage } from '@shared/types'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
  error?: boolean
  retrying?: string
  thinking?: string
  thinkingCollapsed?: boolean // 回复完成后自动折叠
  /** 创建提案草稿（渲染确认卡）；与 text 互斥 */
  draft?: CreateDraft
  /** 确认卡状态（pending 可交互；saved/cancelled 定格） */
  cardStatus?: CardStatus
}

/** 把历史消息转成 ChatMessage（用于渲染） */
function toChatMessages(msgs: SessionMessage[]): ChatMessage[] {
  return msgs.map((m) => {
    const thinking = (m.meta as { thinking?: string } | undefined)?.thinking
    return {
      id: m.id,
      role: m.role === 'tool' ? 'user' : (m.role as 'user' | 'assistant'),
      text: m.content,
      // 历史消息的 thinking 默认折叠（用户可展开查看）
      thinking: thinking || undefined,
      thinkingCollapsed: thinking ? true : undefined,
    }
  })
}

export function HomePage() {
  const { t } = useTranslation(['common', 'home'])
  const sessionId = useChatStore((s) => s.sessionId)
  const historyMessages = useChatStore((s) => s.messages)
  const [streamMsgs, setStreamMsgs] = useState<ChatMessage[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const streamRef = useRef<(() => void) | null>(null)
  const composerRef = useRef<MentionComposerHandle>(null)
  // @提及数据源（角色/能力/技能列表，供下拉补全）
  const agentsQ = useAgents()
  const capabilitiesQ = useCapabilities()
  const skillsQ = useSkills()

  // 自动滚动相关
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const isNearBottomRef = useRef(true)

  // 历史消息 + 本轮流式消息
  const messages = [...toChatMessages(historyMessages), ...streamMsgs]

  // 自动滚动到底部（用户接近底部时才触发，避免打断阅读历史消息）
  const scrollToBottom = useCallback((force = false) => {
    const el = scrollContainerRef.current
    if (!el) return
    if (force || isNearBottomRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: force ? 'smooth' : 'auto' })
    }
  }, [])

  // 消息变化时自动滚动
  useEffect(() => {
    scrollToBottom()
  }, [messages, scrollToBottom])

  // 切换会话时清空流式 + 强制滚动到底部
  useEffect(() => {
    setStreamMsgs([])
    setError(null)
    isNearBottomRef.current = true
    // 延迟一帧确保 DOM 更新后再滚动
    requestAnimationFrame(() => scrollToBottom(true))
  }, [sessionId, scrollToBottom])

  // 订阅流式
  useEffect(() => {
    streamRef.current = window.one.home.onStream((delta) => {
      if (delta.type === 'thinking') {
        // 思考过程累积到末条 AI 消息的 thinking 字段（灰色折叠渲染）
        setStreamMsgs((prev) => {
          const last = prev[prev.length - 1]
          if (last?.role === 'assistant' && (last.streaming || last.retrying || last.thinking !== undefined)) {
            return [...prev.slice(0, -1), {
              ...last,
              thinking: (last.thinking ?? '') + delta.text,
              streaming: true,
            }]
          }
          return [...prev, { id: crypto.randomUUID(), role: 'assistant' as const, text: '', thinking: delta.text, streaming: true }]
        })
      } else if (delta.type === 'text') {
        setStreamMsgs((prev) => {
          const last = prev[prev.length - 1]
          // 若末条是重试提示，先清掉重试态再追加文本
          if (last?.role === 'assistant' && (last.streaming || last.retrying)) {
            const { retrying: _r, ...rest } = last
            void _r
            return [...prev.slice(0, -1), { ...rest, text: rest.text + delta.text, streaming: true }]
          }
          return [...prev, { id: crypto.randomUUID(), role: 'assistant' as const, text: delta.text, streaming: true }]
        })
      } else if (delta.type === 'retry') {
        // 重试等待：在 AI 气泡位置显示「重试中（N/M，等待 Xs）」
        setStreamMsgs((prev) => {
          const last = prev[prev.length - 1]
          if (last?.role === 'assistant' && (last.streaming || last.retrying)) {
            return [...prev.slice(0, -1), {
              ...last,
              streaming: false,
              retrying: `重试 ${delta.attempt}/${delta.maxRetries}，${(delta.delayMs / 1000).toFixed(1)}s 后重试（${delta.reason}）`,
            }]
          }
          return [...prev, { id: crypto.randomUUID(), role: 'assistant' as const, text: '', retrying: `重试 ${delta.attempt}/${delta.maxRetries}，${(delta.delayMs / 1000).toFixed(1)}s 后重试（${delta.reason}）` }]
        })
      } else if (delta.type === 'error') {
        // 错误显示在 AI 气泡位置（而非顶部），含重试按钮
        setStreamMsgs((prev) => {
          const last = prev[prev.length - 1]
          if (last?.role === 'assistant' && (last.streaming || last.retrying)) {
            return [...prev.slice(0, -1), { id: last.id, role: 'assistant' as const, text: delta.error, error: true }]
          }
          return [...prev, { id: crypto.randomUUID(), role: 'assistant' as const, text: delta.error, error: true }]
        })
      } else if (delta.type === 'message_stop') {
        // 回复完成：停止流式 + 自动折叠 thinking
        setStreamMsgs((prev) =>
          prev.map((m, i) =>
            i === prev.length - 1
              ? { ...m, streaming: false, retrying: undefined, thinkingCollapsed: true }
              : m,
          ),
        )
      } else if (delta.type === 'proposal') {
        // 创建提案：在消息流插入确认卡（不落库，待用户确认）
        setStreamMsgs((prev) => [
          ...prev,
          {
            id: delta.draft.draftId,
            role: 'assistant' as const,
            text: '',
            draft: delta.draft,
            cardStatus: 'pending' as const,
          },
        ])
      }
    })
    return () => streamRef.current?.()
  }, [])

  const onSend = async (overrideText?: string): Promise<void> => {
    const text = (overrideText ?? composerRef.current?.getText() ?? '').trim()
    if (!text || sending) return
    if (!overrideText) composerRef.current?.clear()
    setError(null)
    setSending(true)
    // 重试时不清空已有流式消息（保留上下文），仅追加 user 消息
    if (overrideText) {
      setStreamMsgs((prev) => [...prev, { id: crypto.randomUUID(), role: 'user' as const, text }])
    } else {
      setStreamMsgs((prev) => [...prev, { id: crypto.randomUUID(), role: 'user' as const, text }])
    }
    // 发送后强制滚动到底部
    isNearBottomRef.current = true
    requestAnimationFrame(() => scrollToBottom(true))

    try {
      const result = await window.one.home.chat({ message: text, sessionId: sessionId ?? undefined }).then(unwrap)
      // 后端返回 runId=sessionId；若是新会话，存到 store 复用，后续多轮走同一会话
      if (result.runId && result.runId !== sessionId) {
        useChatStore.setState({ sessionId: result.runId })
      }
      // 把本轮流式产出的消息（user + assistant）拉成持久化历史，
      // 清空流式态，避免重复
      if (result.runId) {
        await useChatStore.getState().selectSession(result.runId)
        setStreamMsgs([])
      }
      // 刷新会话列表（新建会话后标题有了）
      void useChatStore.getState().loadSessions()
    } catch (e) {
      const msg = e instanceof IpcError ? e.message : String(e)
      setError(msg)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="chat-shell">
      <div
        className="chat-messages"
        ref={scrollContainerRef}
        onScroll={(e) => {
          const el = e.currentTarget
          const distance = el.scrollHeight - el.scrollTop - el.clientHeight
          isNearBottomRef.current = distance < 80
        }}
      >
        <section className="glass-panel placeholder-card" style={{ borderRadius: 28, padding: 24 }}>
          <p className="section-title">{t('home:welcome')}</p>
          <p className="section-subtitle">{t('home:description')}</p>
        </section>

        {messages.map((m) => (
          <motion.div
            key={m.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className={`message ${m.role === 'user' ? 'message--user' : ''}`}
          >
            {m.role === 'assistant' ? (
              <div className="message__avatar">
                <Sparkles size={16} />
              </div>
            ) : null}
            <div
              className={`message__bubble message__bubble--${m.role}`}
              style={m.error ? { color: 'var(--color-danger)', borderColor: 'var(--color-danger)' } : undefined}
            >
              {m.thinking ? <ThinkingBlock text={m.thinking} collapsed={m.thinkingCollapsed} /> : null}
              {m.draft ? (
                <CreateConfirmCard
                  draft={m.draft}
                  status={m.cardStatus ?? 'pending'}
                  onStatusChange={(status) =>
                    setStreamMsgs((prev) =>
                      prev.map((x) => (x.id === m.id ? { ...x, cardStatus: status } : x)),
                    )
                  }
                />
              ) : m.retrying ? (
                <span style={{ color: 'var(--color-fg-2)', fontSize: '0.85rem' }}>{m.retrying}</span>
              ) : m.role === 'assistant' ? (
                <Markdown>{m.text}</Markdown>
              ) : (
                m.text
              )}
              {m.streaming ? <span className="stream-cursor">▋</span> : null}
              {m.error ? (
                <button
                  type="button"
                  onClick={() => {
                    // 找该错误气泡前最近一条 user 消息重发
                    const idx = messages.findIndex((x) => x.id === m.id)
                    const prevUser = [...messages.slice(0, idx)].reverse().find((x) => x.role === 'user')
                    if (prevUser) {
                      // 删掉错误气泡，重发
                      setStreamMsgs((prev) => prev.filter((x) => x.id !== m.id))
                      void onSend(prevUser.text)
                    }
                  }}
                  style={{
                    marginTop: 8,
                    border: 0,
                    borderRadius: 999,
                    background: 'var(--color-brand-500)',
                    color: 'white',
                    padding: '4px 12px',
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                  }}
                >
                  {t('common:actions.retry')}
                </button>
              ) : null}
            </div>
          </motion.div>
        ))}
      </div>

      <div className="glass-panel composer">
        <MentionComposer
          ref={composerRef}
          agents={agentsQ.data ?? []}
          capabilities={capabilitiesQ.data ?? []}
          skills={skillsQ.data ?? []}
          disabled={sending}
          placeholder={t('home:composerPlaceholder')}
          onSend={(text) => void onSend(text)}
        />
        <button type="button" onClick={() => void onSend()} disabled={sending}>
          {t('common:actions.send')}
        </button>
      </div>
    </div>
  )
}

/** 思考过程折叠块（灰色，默认展开，可折叠） */
function ThinkingBlock({ text, collapsed }: { text: string; collapsed?: boolean }) {
  const [open, setOpen] = useState(!collapsed)
  // 外部 collapsed 变化时同步（回复完成 → 折叠；重试 → 展开）
  useEffect(() => {
    setOpen(!collapsed)
  }, [collapsed])
  return (
    <div className="thinking-block">
      <button
        type="button"
        className="thinking-block__toggle"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="thinking-block__label">思考过程</span>
        <span className="thinking-block__arrow">{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <div className="thinking-block__content">{text}</div>
      ) : null}
    </div>
  )
}
