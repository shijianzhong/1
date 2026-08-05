import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { unwrap } from '@renderer/api/client'
import { IpcError } from '@renderer/api/client'
import { MentionComposer, type MentionComposerHandle } from '@renderer/components/MentionComposer'
import { useAgents, useCapabilities, useSkills } from '@renderer/api/hooks'
import { useChatStore } from '@renderer/store/chat'
import {
  applyOrchEvent,
  closeStreaming,
} from '@renderer/components/orchestra/reducer'
import { toChatMessages, type ChatMessage } from '@renderer/components/orchestra/types'
import { useSpeakerNames } from '@renderer/components/orchestra/useSpeakerNames'
import { MessageItem } from '@renderer/components/orchestra/MessageItem'
import {
  Brain,
  FolderOpen,
  Globe,
  type LucideIcon,
  MessageSquare,
  Puzzle,
  Users,
} from 'lucide-react'
import { startupMark } from '@renderer/lib/startupMark'

/** 新建对话欢迎屏：展示主 Agent 能力概览，有消息后自动隐藏 */
function WelcomeScreen() {
  const { t } = useTranslation(['home'])
  const capItems: { icon: LucideIcon; key: string }[] = [
    { icon: MessageSquare, key: 'chat' },
    { icon: Users, key: 'team' },
    { icon: Puzzle, key: 'create' },
    { icon: Brain, key: 'memory' },
    { icon: FolderOpen, key: 'file' },
    { icon: Globe, key: 'web' },
  ]

  return (
    <section className="welcome-screen">
      <h1 className="welcome-screen__title">{t('welcome.title')}</h1>
      <p className="welcome-screen__subtitle">{t('welcome.subtitle')}</p>
      <div className="welcome-screen__grid">
        {capItems.map((item) => {
          const Icon = item.icon
          return (
            <div key={item.key} className="welcome-screen__card surface-panel">
              <Icon className="welcome-screen__icon" size={28} strokeWidth={1.75} />
              <span className="welcome-screen__label">{t(`welcome.cap.${item.key}`)}</span>
            </div>
          )
        })}
      </div>
      <p className="welcome-screen__hint">{t('welcome.hint')}</p>
    </section>
  )
}

let homeFirstRenderLogged = false

export function HomePage() {
  if (!homeFirstRenderLogged) {
    homeFirstRenderLogged = true
    startupMark('renderer:HomePage:first-render-begin')
  }
  const { t, ready } = useTranslation(['common', 'home'])
  const homeNsLogged = useRef(false)
  useEffect(() => {
    if (ready && !homeNsLogged.current) {
      homeNsLogged.current = true
      startupMark('renderer:HomePage:i18n-ready')
    }
  }, [ready])
  useEffect(() => {
    startupMark('renderer:HomePage:mounted')
  }, [])
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

  // 编排 speaker（executor_id == 节点 id）→ 显示名映射（共享 hook，与编辑器运行面板一致）
  const speakerName = useSpeakerNames()

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
              orbState: 'breathing' as const,
            }]
          }
          return [...prev, { id: crypto.randomUUID(), role: 'assistant' as const, text: '', thinking: delta.text, streaming: true, orbState: 'breathing' as const }]
        })
      } else if (delta.type === 'text') {
        setStreamMsgs((prev) => {
          const last = prev[prev.length - 1]
          // 若末条是重试提示，先清掉重试态再追加文本
          if (last?.role === 'assistant' && (last.streaming || last.retrying)) {
            const { retrying: _r, ...rest } = last
            void _r
            return [...prev.slice(0, -1), { ...rest, text: rest.text + delta.text, streaming: true, orbState: 'composing' as const }]
          }
          return [...prev, { id: crypto.randomUUID(), role: 'assistant' as const, text: delta.text, streaming: true, orbState: 'composing' as const }]
        })
      } else if (delta.type === 'retry') {
        // 重试等待：在 AI 气泡位置显示「重试中（N/M，等待 Xs）」
        setStreamMsgs((prev) => {
          const last = prev[prev.length - 1]
          if (last?.role === 'assistant' && (last.streaming || last.retrying)) {
            return [...prev.slice(0, -1), {
              ...last,
              streaming: false,
              orbState: 'solving' as const,
              retrying: `重试 ${delta.attempt}/${delta.maxRetries}，${(delta.delayMs / 1000).toFixed(1)}s 后重试（${delta.reason}）`,
            }]
          }
          return [...prev, { id: crypto.randomUUID(), role: 'assistant' as const, text: '', orbState: 'solving' as const, retrying: `重试 ${delta.attempt}/${delta.maxRetries}，${(delta.delayMs / 1000).toFixed(1)}s 后重试（${delta.reason}）` }]
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
        // 编排引擎事件（@直跳/组队跑 runner）：共享 reducer（与编辑器运行面板同一渲染逻辑），
        // output 按 speaker 分泡流式渲染；node_error/failed 错误气泡；request_info HITL 提问卡。
        setStreamMsgs((prev) => applyOrchEvent(prev, delta.event))
      } else if (delta.type === 'message_stop') {
        // 回复完成：停止所有流式态 + 末条自动折叠 thinking
        setStreamMsgs((prev) =>
          closeStreaming(prev).map((m, i, arr) =>
            i === arr.length - 1
              ? { ...m, retrying: undefined, thinkingCollapsed: true }
              : m.retrying
                ? { ...m, retrying: undefined }
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
        {messages.length === 0 && <WelcomeScreen />}

        {messages.map((m) => (
          <MessageItem
            key={m.id}
            msg={m}
            speakerName={speakerName}
            onDraftStatusChange={(target, status) =>
              setStreamMsgs((prev) =>
                prev.map((x) => (x.id === target.id ? { ...x, cardStatus: status } : x)),
              )
            }
            onRetryError={(target) => {
              // 找该错误气泡前最近一条 user 消息重发
              const idx = messages.findIndex((x) => x.id === target.id)
              const prevUser = [...messages.slice(0, idx)].reverse().find((x) => x.role === 'user')
              if (prevUser) {
                // 删掉错误气泡，重发
                setStreamMsgs((prev) => prev.filter((x) => x.id !== target.id))
                void onSend(prevUser.text)
              }
            }}
          />
        ))}
      </div>

      <div className="composer">
        <MentionComposer
          ref={composerRef}
          agents={agentsQ.data ?? []}
          capabilities={capabilitiesQ.data ?? []}
          skills={skillsQ.data ?? []}
          disabled={sending}
          placeholder={t('home:composerPlaceholder')}
          onSend={(text) => void onSend(text)}
        />
        {sending ? (
          // 取消闭环：主 Agent 流式 / 组队运行 / ask_user 挂起 统一可停
          <button
            type="button"
            onClick={() => void window.one.home.cancel().catch(() => undefined)}
          >
            {t('common:actions.stop')}
          </button>
        ) : (
          <button type="button" onClick={() => void onSend()}>
            {t('common:actions.send')}
          </button>
        )}
      </div>
    </div>
  )
}
