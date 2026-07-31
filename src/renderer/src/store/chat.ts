import { create } from 'zustand'
import { unwrap } from '@renderer/api/client'
import type { Session, SessionMessage } from '@shared/types'

// —— 聊天会话状态（跨 AppShell SideList + HomePage 共享）——
interface ChatState {
  sessionId: string | null
  sessions: Session[]
  messages: SessionMessage[]
  loadingSession: boolean
  loadSessions: () => Promise<void>
  selectSession: (id: string) => Promise<void>
  newSession: () => Promise<string>
  /** 删除会话；若删的是当前会话则清空聊天区 */
  removeSession: (id: string) => Promise<void>
  setMessages: (msgs: SessionMessage[]) => void
  appendMessage: (msg: SessionMessage) => void
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessionId: null,
  sessions: [],
  messages: [],
  loadingSession: false,
  loadSessions: async () => {
    const list = await window.one.sessions.list().then(unwrap).catch(() => [])
    set({ sessions: list })
  },
  selectSession: async (id) => {
    set({ loadingSession: true })
    // 先取消息，再一次性 set sessionId+messages——避免分两次 set 导致
    // HomePage 的 useEffect([sessionId]) 在 messages 未就位时先清空流式气泡（空白帧）。
    const msgs = await window.one.sessions.messages(id).then(unwrap).catch(() => [])
    set({ sessionId: id, messages: msgs, loadingSession: false })
  },
  newSession: async () => {
    // 不在这里创建（home:chat 时若 sessionId 为空会自动创建），
    // 仅清空当前状态，让下次发送时由后端建会话
    set({ sessionId: null, messages: [] })
    await get().loadSessions()
    return ''
  },
  removeSession: async (id) => {
    await window.one.sessions.remove(id).then(unwrap)
    const { sessionId } = get()
    set((s) => ({
      sessions: s.sessions.filter((x) => x.id !== id),
      ...(sessionId === id ? { sessionId: null, messages: [] } : {}),
    }))
  },
  setMessages: (msgs) => set({ messages: msgs }),
  appendMessage: (msg) =>
    set((s) => ({ messages: [...s.messages, msg] })),
}))
