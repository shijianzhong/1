import type { Session, SessionMessage } from '@shared/types'
import { withHandler } from './handler'
import {
  addMessage,
  createSession,
  getSession,
  listMessages,
  listSessions,
  removeSession,
  renameSession,
} from '../storage/sessions'

// —— 会话历史 IPC（§八之二 B）——
export function registerSessionsHandlers(): void {
  withHandler<Session[]>('sessions:list', () => listSessions())
  withHandler<Session | null>('sessions:get', (_e, id) => getSession(id as string))
  withHandler<void>('sessions:remove', (_e, id) => removeSession(id as string))
  withHandler<void>('sessions:rename', (_e, id, title) =>
    renameSession(id as string, title as string),
  )
  withHandler<SessionMessage[]>('sessions:messages', (_e, sessionId) =>
    listMessages(sessionId as string),
  )
  withHandler<Session>('sessions:create', (_e, input) =>
    createSession(input as { title: string; capabilityId?: string }),
  )
  withHandler<SessionMessage>('sessions:addMessage', (_e, input) =>
    addMessage(input as { sessionId: string; role: 'user' | 'assistant' | 'tool'; content: string; meta?: unknown }),
  )
}
