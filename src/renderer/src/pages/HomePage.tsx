import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { unwrap, errorMessage } from '@renderer/api/client'
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
import { SelectionToolbar } from '@renderer/components/SelectionToolbar'
import type { CreateDraft } from '@shared/types'
import { mentionTokensToDisplay, type MentionKind } from '@shared/mentions'
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
  // 项目根：会话 cwd（persisted） > 本地暂存（新会话选好后随首条消息写入）
  const [projectPath, setProjectPath] = useState<string | null>(null)
  useEffect(() => {
    if (!sessionId) return
    void window.one.sessions.getCwd(sessionId).then(unwrap).then((cwd) => {
      if (cwd) setProjectPath(cwd)
    }).catch(() => undefined)
  }, [sessionId])
  const pickProject = async (): Promise<void> => {
    const p = await window.one.app.pickDirectory().then(unwrap).catch(() => null)
    if (p) setProjectPath(p)
  }

  // 崩溃恢复：未发送输入 debounce 落盘（2s 轮询 composer）
  useEffect(() => {
    const tick = (): void => {
      const text = composerRef.current?.getText()?.trim() ?? ''
      if (!text) {
        void window.one.app.removeDraft('home-composer.json').catch(() => undefined)
        return
      }
      void window.one.app
        .writeDraft({
          name: 'home-composer.json',
          content: JSON.stringify({
            kind: 'home-composer',
            text,
            sessionId: sessionId ?? null,
            updatedAt: Date.now(),
          }),
        })
        .catch(() => undefined)
    }
    const id = window.setInterval(tick, 2000)
    return () => window.clearInterval(id)
  }, [sessionId])
  // @提及数据源（角色/能力/技能列表，供下拉补全）
  const agentsQ = useAgents()
  const capabilitiesQ = useCapabilities()
  const skillsQ = useSkills()
  // 历史里若仍存 @[kind:id]，展示时还原为 @名字
  const displayHistory = toChatMessages(historyMessages).map((m) => {
    if (m.role !== 'user') return m
    return {
      ...m,
      text: mentionTokensToDisplay(m.text, (kind: MentionKind, id: string) => {
        if (kind === 'agent') return agentsQ.data?.find((a) => a.id === id)?.name
        if (kind === 'capability') return capabilitiesQ.data?.find((c) => c.id === id)?.name
        return skillsQ.data?.find((s) => s.id === id)?.name
      }),
    }
  })

  // 编排 speaker（executor_id == 节点 id）→ 显示名映射（共享 hook，与编辑器运行面板一致）
  const speakerName = useSpeakerNames()

  // 自动滚动相关
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const isNearBottomRef = useRef(true)

  // 历史消息 + 本轮流式消息
  const messages = [...displayHistory, ...streamMsgs]

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

  // 把未确认创建草稿挂回消息流（回合结束清 stream / 切回会话时用）
  const draftCardsFrom = useCallback((drafts: CreateDraft[]): ChatMessage[] => {
    return drafts.map((draft) => ({
      id: draft.draftId,
      role: 'assistant' as const,
      text: '',
      draft,
      cardStatus: 'pending' as const,
    }))
  }, [])

  // 切换会话：清空流式，但重挂该会话未确认的创建卡（防「确认入库」卡被吞掉）
  useEffect(() => {
    setError(null)
    isNearBottomRef.current = true
    if (!sessionId) {
      setStreamMsgs([])
      return
    }
    let cancelled = false
    void window.one.home
      .listPendingDrafts({ sessionId })
      .then(unwrap)
      .then((drafts) => {
        if (!cancelled) setStreamMsgs(draftCardsFrom(drafts))
      })
      .catch(() => {
        if (!cancelled) setStreamMsgs([])
      })
    requestAnimationFrame(() => scrollToBottom(true))
    return () => {
      cancelled = true
    }
  }, [sessionId, scrollToBottom, draftCardsFrom])

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
          return [...prev, { id: crypto.randomUUID(), role: 'assistant' as const, text: '', thinking: delta.text, streaming: true, orbState: 'breathing' as const, createdAt: Date.now() }]
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
          return [...prev, { id: crypto.randomUUID(), role: 'assistant' as const, text: delta.text, streaming: true, orbState: 'composing' as const, createdAt: Date.now() }]
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
              retrying: t('home:retry.waiting', { attempt: delta.attempt, maxRetries: delta.maxRetries, delay: (delta.delayMs / 1000).toFixed(1), reason: delta.reason }),
            }]
          }
          return [...prev, { id: crypto.randomUUID(), role: 'assistant' as const, text: '', orbState: 'solving' as const, retrying: t('home:retry.waiting', { attempt: delta.attempt, maxRetries: delta.maxRetries, delay: (delta.delayMs / 1000).toFixed(1), reason: delta.reason }), createdAt: Date.now() }]
        })
      } else if (delta.type === 'error') {
        // 错误显示在 AI 气泡位置（而非顶部），含重试按钮
        setStreamMsgs((prev) => {
          const last = prev[prev.length - 1]
          if (last?.role === 'assistant' && (last.streaming || last.retrying)) {
            return [...prev.slice(0, -1), { id: last.id, role: 'assistant' as const, text: delta.error, error: true }]
          }
          return [...prev, { id: crypto.randomUUID(), role: 'assistant' as const, text: delta.error, error: true, createdAt: Date.now() }]
        })
      } else if (delta.type === 'orch_event') {
        // 编排引擎事件（@直跳/组队跑 runner）：共享 reducer（与编辑器运行面板同一渲染逻辑），
        // output 按 speaker 分泡流式渲染；node_error/failed 错误气泡；request_info HITL 提问卡。
        setStreamMsgs((prev) => applyOrchEvent(prev, delta.event))
      } else if (delta.type === 'message_stop') {
        // 回复完成：停止所有流式态 + 末条自动折叠 thinking + 记录 token 用量
        setStreamMsgs((prev) =>
          closeStreaming(prev).map((m, i, arr) =>
            i === arr.length - 1
              ? { ...m, retrying: undefined, thinkingCollapsed: true, tokenUsage: delta.usage }
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
      } else if (delta.type === 'proposal_error') {
        setStreamMsgs((prev) => [
          ...prev,
          {
            id: `propose_err_${crypto.randomUUID()}`,
            role: 'assistant' as const,
            text: '',
            proposalError: {
              kind: delta.kind,
              error: delta.error,
              messageKey: delta.messageKey,
              detail: delta.detail,
            },
          },
        ])
      } else if (delta.type === 'create_notice') {
        setStreamMsgs((prev) => [
          ...prev,
          {
            id: `create_notice_${crypto.randomUUID()}`,
            role: 'assistant' as const,
            text: '',
            createNotice: {
              messageKey: delta.messageKey,
              params: delta.params,
              level: delta.level,
            },
          },
        ])
      }
    })
    return () => streamRef.current?.()
  }, [])

  const onSend = async (overrideText?: string): Promise<void> => {
    // 芯片旁路须在 clear 前取（展示正文是 @名字，id 另传）。
    // Enter 会把 getText() 当 overrideText 传入，此时 composer 里芯片仍在。
    const chipMentions = (composerRef.current?.getMentions() ?? []).map((m) => ({
      kind: m.kind,
      id: m.id,
    }))
    const text = (overrideText ?? composerRef.current?.getText() ?? '').trim()
    if (!text || sending) return
    // 发送即清空输入框（overrideText 来自重试按钮，不来自 composer，清空无害）；
    // 修复此前仅 !overrideText 才清空导致 Enter 发送后内容残留的问题。
    composerRef.current?.clear()
    void window.one.app.removeDraft('home-composer.json').catch(() => undefined)
    setError(null)
    setSending(true)
    // 追加 user 消息 + 立即创建空的 AI 流式气泡（含 orbState=working）
    // 避免 API 响应延迟期间屏幕上只有 user 消息、无 AI 图标 → 感觉卡住
    setStreamMsgs((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: 'user' as const, text, createdAt: Date.now() },
      { id: crypto.randomUUID(), role: 'assistant' as const, text: '', streaming: true, orbState: 'working' as const, createdAt: Date.now() },
    ])
    // 发送后强制滚动到底部
    isNearBottomRef.current = true
    requestAnimationFrame(() => scrollToBottom(true))

    try {
      const result = await window.one.home
        .chat({
          message: text,
          sessionId: sessionId ?? undefined,
          projectPath: projectPath ?? undefined,
          mentions: chipMentions.length > 0 ? chipMentions : undefined,
        })
        .then(unwrap)
      // 把本轮流式产出拉成持久化历史；未确认创建卡绝不能跟 streamMsgs 一起清掉——
      // 否则 propose_* 弹卡后回合一结束卡就消失，用户永远点不到「确认入库」。
      // 失败卡 / 补跑失败提示也要保留（否则用户看不到可重试出口）。
      if (result.runId) {
        await useChatStore.getState().selectSession(result.runId)
        const pending = await window.one.home
          .listPendingDrafts({ sessionId: result.runId })
          .then(unwrap)
          .catch(() => [] as CreateDraft[])
        setStreamMsgs((prev) => {
          const keep = prev.filter(
            (m) =>
              m.proposalError ||
              (m.createNotice?.messageKey.includes('recovery.failed') ?? false),
          )
          return [...draftCardsFrom(pending), ...keep]
        })
      }
      // 刷新会话列表（新建会话后标题有了）
      void useChatStore.getState().loadSessions()
    } catch (e) {
      const msg = errorMessage(e, t)
      setError(msg)
    } finally {
      setSending(false)
    }
  }

  const pendingCreateCount = messages.filter(
    (m) => m.draft && (m.cardStatus === undefined || m.cardStatus === 'pending'),
  ).length

  const scrollToPendingCreate = (): void => {
    const el = scrollContainerRef.current?.querySelector('.create-card--pending, .create-card:not(.create-card--saved):not(.create-card--cancelled):not(.create-card--error)')
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  return (
    <div className="chat-shell">
      {pendingCreateCount > 0 ? (
        <button
          type="button"
          className="create-pending-bar"
          onClick={scrollToPendingCreate}
        >
          {t('home:create.pendingBar', { count: pendingCreateCount })}
        </button>
      ) : null}
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
            onRetryProposalError={(target) => {
              if (!target.proposalError) return
              const kindLabel = t(`home:create.kind.${target.proposalError.kind}`)
              setStreamMsgs((prev) => prev.filter((x) => x.id !== target.id))
              void onSend(t('home:create.error.retryPrompt', { kind: kindLabel }))
            }}
          />
        ))}

        <SelectionToolbar
          containerRef={scrollContainerRef}
          onQuote={(text) => {
            composerRef.current?.insertText(`> ${text}\n\n`)
            composerRef.current?.focus()
          }}
          onAsk={(action, text) => {
            const prefix = t(`common:selection.${action}Prefix`)
            void onSend(`${prefix}${text}`)
          }}
        />
      </div>

      <div className="chat-top-bar">
        <button
          type="button"
          className="project-chip"
          onClick={() => void pickProject()}
          title={projectPath ?? undefined}
        >
          <FolderOpen size={14} />
          <span className="project-chip__name">
            {projectPath
              ? projectPath.split('/').pop() ?? projectPath
              : t('home:selectProject', '选择项目目录')}
          </span>
        </button>
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
