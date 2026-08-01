import { z } from 'zod'
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
// 入参 Zod 校验：IPC 边界不做隐式 as 断言，畸形参数在入口处结构化报错（P1-12）。

const IdSchema = z.string().min(1)

const CreateSessionSchema = z.object({
  title: z.string().min(1),
  capabilityId: z.string().optional(),
})

const AddMessageSchema = z.object({
  sessionId: z.string().min(1),
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string(),
  meta: z.unknown().optional(),
})

export function registerSessionsHandlers(): void {
  withHandler<Session[]>('sessions:list', () => listSessions())
  withHandler<Session | null>('sessions:get', (_e, id) => getSession(IdSchema.parse(id)))
  withHandler<void>('sessions:remove', (_e, id) => removeSession(IdSchema.parse(id)))
  withHandler<void>('sessions:rename', (_e, id, title) =>
    renameSession(IdSchema.parse(id), z.string().min(1).parse(title)),
  )
  withHandler<SessionMessage[]>('sessions:messages', (_e, sessionId) =>
    listMessages(IdSchema.parse(sessionId)),
  )
  withHandler<Session>('sessions:create', (_e, input) =>
    createSession(CreateSessionSchema.parse(input)),
  )
  withHandler<SessionMessage>('sessions:addMessage', (_e, input) =>
    addMessage(AddMessageSchema.parse(input)),
  )
}
