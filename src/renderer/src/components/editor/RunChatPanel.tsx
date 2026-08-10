import { useEffect, useRef, useState } from 'react'
import { Play, Square, FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { MessageItem } from '@renderer/components/orchestra/MessageItem'
import type { ChatMessage } from '@renderer/components/orchestra/types'

// —— 编辑器运行聊天面板（与首页 @能力 运行同一渲染体系：MessageItem + applyOrchEvent）——
// 每条用户消息触发一次 workflow 运行（与首页语义一致：能力运行无状态，turn 间不共享
// executor cache）；运行中角色经 ask_user 提问 → 提问卡内嵌作答，不抢 composer。
// 顶部项目选择器：选定的 projectRoot 经 orchestrate.run 写入 sessions.cwd，agent 文件
// 工具/shell 默认 cwd 用（grep/glob/str_replace 够到代码项目）。

export function RunChatPanel({
  messages,
  speakerName,
  running,
  onSend,
  onStop,
  projectPath,
  onPickProject,
  t,
}: {
  messages: ChatMessage[]
  speakerName: (id: string) => string
  running: boolean
  onSend: (text: string) => void
  onStop: () => void
  /** 当前项目根（null = 未选） */
  projectPath: string | null
  /** 选择项目目录 */
  onPickProject: () => void
  t: TFunction
}) {
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const isNearBottomRef = useRef(true)

  // 新消息自动滚底（用户接近底部时；上翻阅读不打断）
  useEffect(() => {
    const el = scrollRef.current
    if (el && isNearBottomRef.current) {
      el.scrollTo({ top: el.scrollHeight })
    }
  }, [messages])

  const send = (): void => {
    const text = draft.trim()
    if (!text || running) return
    setDraft('')
    isNearBottomRef.current = true
    onSend(text)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, gap: 10 }}>
      {/* 消息列表 */}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
        style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'grid', gap: 10, alignContent: 'start' }}
      >
        {messages.length === 0 ? (
          <p className="section-subtitle" style={{ fontSize: '0.8rem', lineHeight: 1.7 }}>
            {t('editor:runChat.empty')}
          </p>
        ) : (
          messages.map((m) => <MessageItem key={m.id} msg={m} speakerName={speakerName} />)
        )}
      </div>

      {/* composer：项目路径 chip + 任务输入 + 运行按钮 */}
      <div style={{ display: 'grid', gap: 6 }}>
        <div className="chat-top-bar">
          <button
            type="button"
            className="project-chip"
            onClick={onPickProject}
            title={projectPath ?? undefined}
          >
            <FolderOpen size={14} />
            <span className="project-chip__name">
              {projectPath
                ? projectPath.split('/').pop() ?? projectPath
                : t('editor:runChat.selectProject')}
            </span>
          </button>
        </div>
        <textarea
          value={draft}
          disabled={running}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder={t('editor:runChat.placeholder')}
          rows={3}
          className="w-full resize-none rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-2)] px-3 py-2 text-sm text-[var(--color-fg-1)] outline-none placeholder:text-[var(--color-fg-3)] focus:border-[var(--color-brand-400)]"
        />
        {running ? (
          <button type="button" className="run-chat__stop" onClick={onStop}>
            <Square size={13} /> {t('editor:stop')}
          </button>
        ) : (
          <button
            type="button"
            className="run-chat__send"
            disabled={!draft.trim()}
            onClick={send}
          >
            <Play size={13} /> {t('editor:run')}
          </button>
        )}
      </div>
    </div>
  )
}
