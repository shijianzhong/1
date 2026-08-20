// —— 知识库（向量）IPC handlers（docs/VECTOR_KB_PLAN.md §二）——
//
// P0 仅 kb:status（探 provider 就绪 + chunk 计数，供前端显示「未就绪/已就绪」）。
// kb:search/add/remove/list/reindex 后置 P1/P2。镜像 models.ts 的 withHandler 范式。

import { withHandler } from './handler'
import { getKbStatus } from '../vector/embed'
import type { KbStatus } from '@shared/types'

export function registerKnowledgeHandlers(): void {
  withHandler<KbStatus>('kb:status', () => getKbStatus())
}
