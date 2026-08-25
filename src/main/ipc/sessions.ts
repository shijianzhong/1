import { dialog, BrowserWindow } from 'electron'
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
import { sessionToMarkdown } from '../storage/export'
import { writeFileAtomic } from '../tools/builtin/file'
import { clearSessionToolApprovals } from '../tools/sessionApprovals'

// —— 会话历史 IPC（§八之二 B）——
// 入参 Zod 校验：IPC 边界不做隐式 as 断言，畸形参数在入口处结构化报错（P1-12）。

const IdSchema = z.string().min(1)

const CreateSessionSchema = z.object({
  title: z.string().min(1),
  capabilityId: z.string().optional(),
  cwd: z.string().optional(),
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
  withHandler<string | null>('sessions:getCwd', (_e, sessionId) => {
    const s = getSession(IdSchema.parse(sessionId))
    return s?.cwd ?? null
  })
  withHandler<void>('sessions:remove', (_e, id) => {
    const sid = IdSchema.parse(id)
    removeSession(sid)
    clearSessionToolApprovals(sid) // 删会话时清掉「本会话允许」放行
  })
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

  // —— 会话导出（§亮点②）——
  withHandler<string>('sessions:export', (_e, sessionId) =>
    sessionToMarkdown(IdSchema.parse(sessionId)),
  )
  withHandler<string | null>('sessions:exportFile', async (e, sessionId, defaultName) => {
    const sid = IdSchema.parse(sessionId)
    const name = z.string().min(1).optional().parse(defaultName) ?? 'conversation'
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0] ?? null
    const result = await dialog.showSaveDialog(win, {
      title: '导出会话为 Markdown',
      defaultPath: `${name}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (result.canceled || !result.filePath) return null
    const md = sessionToMarkdown(sid)
    if (!md) return null // 会话不存在：不落空文件
    await writeFileAtomic(result.filePath, md)
    return result.filePath
  })
}
