// —— 知识库（向量）IPC handlers（docs/VECTOR_KB_PLAN.md §七）——
//
// kb:status               —— P0 探 provider 就绪 + chunk 计数（供前端显示）
// kb:add                  —— P1 摄取：分块 → 向量化 → 入库（ingestDocument）；P5 加 url 分支
// kb:pickFile             —— P5 弹文件选择框 → 抽取（pdf/docx/txt/md/html）→ ingest
// kb:list                 —— P1 列文档元信息（不含 content 原文，避免大原文过 IPC）
// kb:remove               —— P1 删文档（级联 chunks + FTS + doc）
// kb:search               —— P2 hybrid 检索（向量 + FTS + RRF 融合，降级纯词法）
// kb:reindex              —— P4 批量重嵌（NULL backfill + 全量重嵌，进度流 kb:reindex:progress）
// kb:reindex:cancel       —— P4 取消重嵌（AbortController 翻转）
// kb:downloadModel        —— P4 运行时下载本地模型（进度流 kb:downloadModel:progress）
// kb:getProviderPreference —— P4 取活跃 embedding provider 偏好
// kb:setProviderPreference —— P4 设活跃 embedding provider（触发重嵌标记）
//
// 入参 Zod 校验：畸形参数在入口处结构化报错。ZodError 原生无 messageKey，此处捕获后
// 转 IpcErrorThrow('errors:kb.invalid_input') 让渲染层按 i18n key 翻译（铁律 T2：不硬编码中文）。
// 文件抽取/URL 抓取只在主进程（铁律1：渲染层 sandbox，文件读不经 IPC 暴露）。

import { z } from 'zod'
import { dialog } from 'electron'
import { basename } from 'node:path'
import { withHandler } from './handler'
import { parseFileDialogLabels } from './dialog-labels'
import { IpcErrorThrow } from '@shared/types'
import { getKbStatus, setActiveProvider, invalidateLocalModelProbe } from '../vector/embed'
import { ingestDocument } from '../vector/pipeline'
import { deleteKbDoc, listKbDocsLite } from '../vector/store'
import { searchKbHybrid } from '../vector/search'
import { runReindex, cancelReindex } from '../vector/reindex'
import { downloadKbModel } from '../vector/download-model'
import { extractFromFile, extractFromUrl } from '../vector/extract'
import { getAppMeta } from '../storage/db'
import { logger } from '../logger'
import type {
  KbAddInput,
  KbAddResult,
  KbDocListItem,
  KbProviderPreference,
  KbReindexResult,
  KbSearchInput,
  KbSearchResult,
  KbStatus,
} from '@shared/types'

const KbAddSchema = z.object({
  title: z.string().min(1),
  content: z.string().optional(),
  url: z.string().optional(),
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

const KbProviderPreferenceSchema = z.object({
  providerId: z.string().nullable(),
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
    const hasUrl = !!input.url?.trim()
    const hasContent = !!input.content?.trim()
    if (hasUrl && hasContent) {
      // url 与 content 互斥：抓取来的文本 vs 直传文本不应同来
      throw new IpcErrorThrow('errors:kb.invalid_input')
    }
    if (!hasUrl && !hasContent) {
      throw new IpcErrorThrow('errors:kb.empty_content')
    }
    if (hasUrl) {
      // P5：URL 抓取 → content（Jina Reader，主进程读 process.env.JINA_API_KEY）
      const doc = await extractFromUrl(input.url!.trim())
      const result = await ingestDocument({
        title: input.title || doc.title || input.url!.trim(),
        content: doc.content,
        sourceKind: 'url',
        sourcePath: input.url!.trim(),
        docId: input.docId,
      })
      return result
    }
    // 直传文本路径（content-XOR-url 的另一半）
    const result = await ingestDocument({
      ...input,
      content: input.content!,
    })
    return result
  })

  // P5：文件摄取——弹原生文件框 → 抽取（pdf/docx/txt/md/html）→ ingestDocument。
  // 镜像 skills:pickFile 的「dialog → 解析 → save → 资源 → 回滚」范式。
  // canceled 返 null（渲染层据此留开抽屉不报错）；抽取在 ingest 前，抛错则未写任何东西。
  // 对话框文案由渲染层 i18n 后传入（铁律 T2：主进程不硬编码中文，review #27）。
  withHandler<KbAddResult | null>('kb:pickFile', async (_e, labelsRaw) => {
    const labels = parseFileDialogLabels(labelsRaw, 'errors:kb.invalid_input')
    const result = await dialog.showOpenDialog({
      title: labels.title,
      properties: ['openFile'],
      filters: [
        { name: labels.fileLabel, extensions: ['pdf', 'docx', 'txt', 'md', 'html', 'htm'] },
        { name: labels.allFilesLabel, extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    const doc = await extractFromFile(filePath)
    let createdDocId: string | undefined
    try {
      const r = await ingestDocument({
        title: doc.title ?? basename(filePath),
        content: doc.content,
        sourceKind: doc.sourceKind,
        sourcePath: filePath,
      })
      createdDocId = r.docId
      return r
    } catch (e) {
      // ingest 契约不抛，但防御性回滚：万一写了 doc 则删（chunks 级联）
      logger.warn('[kb:pickFile] ingest 失败，回滚', e)
      if (createdDocId) deleteKbDoc(createdDocId)
      throw e
    }
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

  // —— P4 ——
  withHandler<KbReindexResult>('kb:reindex', async () => runReindex())

  withHandler<void>('kb:reindex:cancel', () => cancelReindex())

  withHandler<void>('kb:downloadModel', async () => {
    await downloadKbModel()
    // 模型文件已变更 → 失效 hasLocalModel 探测缓存（否则 status 长时间停留在 missing）
    invalidateLocalModelProbe()
  })

  withHandler<KbProviderPreference>('kb:getProviderPreference', () => ({
    providerId: getAppMeta('kb_embedding_provider_id') || null,
  }))

  withHandler<KbProviderPreference>('kb:setProviderPreference', (_e, inputRaw) => {
    let pref: KbProviderPreference
    try {
      pref = KbProviderPreferenceSchema.parse(inputRaw) as KbProviderPreference
    } catch {
      throw new IpcErrorThrow('errors:kb.invalid_input')
    }
    setActiveProvider(pref.providerId)
    return pref
  })
}
