// —— 知识库（向量）IPC handlers（docs/VECTOR_KB_PLAN.md §七）——
//
// kb:status  —— P0 探 provider 就绪 + chunk 计数（供前端显示）
// kb:add     —— P1 摄取：分块 → 向量化 → 入库（ingestDocument）
// kb:list    —— P1 列文档元信息（不含 content 原文，避免大原文过 IPC）
// kb:remove  —— P1 删文档（级联 chunks + FTS + doc）
// kb:search  —— P2 hybrid 检索（向量 + FTS + RRF 融合，降级纯词法）
//
// 入参 Zod 校验：畸形参数在入口处结构化报错。ZodError 原生无 messageKey，此处捕获后
// 转 IpcErrorThrow('errors:kb.invalid_input') 让渲染层按 i18n key 翻译（铁律 T2：不硬编码中文）。

import { z } from 'zod'
import { withHandler } from './handler'
import { IpcErrorThrow } from '@shared/types'
import { getKbStatus } from '../vector/embed'
import { ingestDocument } from '../vector/pipeline'
import { deleteKbDoc, listKbDocsLite } from '../vector/store'
import { searchKbHybrid } from '../vector/search'
import type {
  KbAddInput,
  KbAddResult,
  KbDocListItem,
  KbSearchInput,
  KbSearchResult,
  KbStatus,
} from '@shared/types'

const KbAddSchema = z.object({
  title: z.string().min(1),
  content: z.string(),
  sourceKind: z.string().optional(),
  sourcePath: z.string().optional(),
  docId: z.string().optional(),
})

const DocIdSchema = z.string().min(1)

const KbSearchSchema = z.object({
  query: z.string().min(1),
  k: z.number().int().positive().max(50).optional(),
  docIds: z.array(z.string().min(1)).optional(),
})

export function registerKnowledgeHandlers(): void {
  withHandler<KbStatus>('kb:status', () => getKbStatus())

  withHandler<KbAddResult>('kb:add', async (_e, inputRaw) => {
    let input: KbAddInput
    try {
      input = KbAddSchema.parse(inputRaw) as KbAddInput
    } catch {
      throw new IpcErrorThrow('errors:kb.invalid_input')
    }
    if (!input.content || !input.content.trim()) {
      throw new IpcErrorThrow('errors:kb.empty_content')
    }
    const result = await ingestDocument(input)
    return result
  })

  withHandler<KbDocListItem[]>('kb:list', () => listKbDocsLite() as KbDocListItem[])

  withHandler<{ deleted: true }>('kb:remove', (_e, docIdRaw) => {
    let docId: string
    try {
      docId = DocIdSchema.parse(docIdRaw)
    } catch {
      throw new IpcErrorThrow('errors:kb.invalid_input')
    }
    deleteKbDoc(docId)
    return { deleted: true as const }
  })

  withHandler<KbSearchResult>('kb:search', async (_e, inputRaw) => {
    let input: KbSearchInput
    try {
      input = KbSearchSchema.parse(inputRaw) as KbSearchInput
    } catch {
      throw new IpcErrorThrow('errors:kb.invalid_input')
    }
    const result = await searchKbHybrid(input.query, {
      k: input.k,
      docIds: input.docIds,
    })
    return result
  })
}
