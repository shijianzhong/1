import type { TaskRecord } from '@shared/types'
import { withHandler } from './handler'
import { createTask, getTask, listTasks, updateTaskStatus } from '../storage/tasks'

// —— 任务历史 IPC（§八之二 B）——
export function registerTasksHandlers(): void {
  withHandler<TaskRecord[]>('tasks:list', () => listTasks())
  withHandler<TaskRecord | null>('tasks:get', (_e, id) => getTask(id as string))
  withHandler<TaskRecord>('tasks:create', (_e, input) =>
    createTask(
      input as { sessionId?: string; capabilityId?: string; graph?: import('@shared/types').WorkflowGraph },
    ),
  )
  withHandler<void>('tasks:updateStatus', (_e, id, status, extra) =>
    updateTaskStatus(
      id as string,
      status as TaskRecord['status'],
      extra as { result?: unknown; error?: string } | undefined,
    ),
  )
}
