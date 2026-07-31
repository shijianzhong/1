import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  /** 编排发言者（orch_event output 气泡，executor_id == agent name） */
  speaker?: string
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

  // 编排 speaker（executor_id == 节点 id）→ 显示名映射（气泡头部显示用）。
  // 覆盖三种 id 形态（§铁律20 + P1 修复）：
  // - 角色库 id（agt_xxx）：@角色直跳/主Agent组队，node.id == Agent.id
  // - 能力库 id（cap_xxx）：能力作 participant，node.id == Capability.id
  // - 画布生成 id（agent_xxx）：能力图直接跑/@能力直跳，node.id 是 EditorPage 生成的时间戳 id，
  //   库中查不到 → 遍历能力图节点取 data.label（节点显示名）兜底。
  // 用 Map O(1) 查找，避免每条消息对 agents/capabilities 线性扫描。
  const speakerNameMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const a of agentsQ.data ?? []) m.set(a.id, a.name)
    for (const c of capabilitiesQ.data ?? []) {
      m.set(c.id, c.name)
      for (const n of c.graph?.nodes ?? []) {
        const label = (n.data as { label?: string } | undefined)?.label
        if (label && !m.has(n.id)) m.set(n.id, label)
      }
    }
    return m
  }, [agentsQ.data, capabilitiesQ.data])
  const speakerName = useCallback((id: string): string => speakerNameMap.get(id) ?? id, [speakerNameMap])

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
      } else if (delta.type === 'orch_event') {
        // 编排引擎事件（@直跳/组队跑 runner）：output 按 speaker 分泡流式渲染，
        // node_error/failed 显示为错误气泡。node_started/node_done/handoff 暂不展示。
        const ev = delta.event
        if (ev.type === 'output') {
          setStreamMsgs((prev) => {
            const last = prev[prev.length - 1]
            // 同 speaker 的末条流式气泡：final 事件替换文本（终端完整输出，去掉已累加的增量重复），
            // 增量事件累加文本。
            if (last?.role === 'assistant' && last.streaming && !last.draft && last.speaker === ev.speaker) {
              const text = ev.final ? ev.text : last.text + ev.text
              return [...prev.slice(0, -1), { ...last, text, streaming: !ev.final }]
            }
            // final 事件到达时若末条不是该 speaker 的流式气泡，说明增量未建立气泡（如 groupchat 容器
            // 非流式输出）→ 直接用完整文本新建成形气泡（streaming=false）。
            return [
              ...prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
              {
                id: crypto.randomUUID(),
                role: 'assistant' as const,
                text: ev.text,
                streaming: !ev.final,
                speaker: ev.speaker,
              },
            ]
          })
        } else if (ev.type === 'node_error' || ev.type === 'failed') {
          const errText = ev.type === 'node_error' ? `${ev.node_id}: ${ev.error}` : ev.error
          setStreamMsgs((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: 'assistant' as const, text: errText, error: true },
          ])
        }
      } else if (delta.type === 'message_stop') {
        // 回复完成：停止所有流式态 + 末条自动折叠 thinking
        setStreamMsgs((prev) =>
          prev.map((m, i) =>
            i === prev.length - 1
              ? { ...m, streaming: false, retrying: undefined, thinkingCollapsed: true }
              : m.streaming || m.retrying
                ? { ...m, streaming: false, retrying: undefined }
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
    // 发送即清空输入框（overrideText 来自重试按钮，不来自 composer，清空无害）；
    // 修复此前仅 !overrideText 才清空导致 Enter 发送后内容残留的问题。
    composerRef.current?.clear()
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
      // 把本轮流式产出的消息（user + assistant）拉成持久化历史，清空流式态避免重复。
      // selectSession 一次性 set sessionId+messages（含新会话），无需单独 setState。
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
              {m.speaker ? <div className="message__speaker">{speakerName(m.speaker)}</div> : null}
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
          {sending ? t('common:actions.sending') : t('common:actions.send')}
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
