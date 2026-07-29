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
    set({ loadingSession: true, sessionId: id })
    const msgs = await window.one.sessions.messages(id).then(unwrap).catch(() => [])
    set({ messages: msgs, loadingSession: false })
  },
  newSession: async () => {
    // 不在这里创建（home:chat 时若 sessionId 为空会自动创建），
    // 仅清空当前状态，让下次发送时由后端建会话
    set({ sessionId: null, messages: [] })
    await get().loadSessions()
    return ''
  },
  setMessages: (msgs) => set({ messages: msgs }),
  appendMessage: (msg) =>
    set((s) => ({ messages: [...s.messages, msg] })),
}))
