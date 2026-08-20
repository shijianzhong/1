// —— kb_search 工具（docs/VECTOR_KB_PLAN.md §八 P2）——
//
// Agent 按需检索知识库文档分块。走 searchKbHybrid（向量 + FTS + RRF 融合），
// 未向量化时自动退化为纯词法命中（searchKbHybrid 内降级链保证）。
//
// 只读检索：approvalMode 省略 = 'auto'（镜像 skill_search，不弹审批）。
// 返回为 LLM 精简结构（content 截断 2000 字 + score + 来源），registry JSON.stringify 喂 LLM。

import { z } from 'zod'
import { searchKbHybrid } from '../../vector/search'
import { registerTool } from '../registry'

export function registerKbSearchTools(): void {
  registerTool(
    'kb_search',
    '按语义+词法混合检索知识库文档。适用于需要查阅已入库资料（文档/手册/笔记）回答的问题；返回相关分块内容与来源。未向量化时退化为纯词法命中。闲聊或通用知识问答不要调用。',
    z.object({
      query: z.string().describe('检索查询，自然语言或关键词'),
      k: z.number().int().positive().max(20).optional().describe('返回上限，默认 5'),
      docIds: z.array(z.string()).optional().describe('限定在这些文档内检索'),
    }),
    async (args) => {
      const { query, k, docIds } = args as { query: string; k?: number; docIds?: string[] }
      const { hits, degraded } = await searchKbHybrid(query, { k: k ?? 5, docIds })
      return {
        degraded, // 让 LLM 知道这是纯词法命中（向量路缺失）
        hits: hits.map((h) => ({
          docId: h.docId,
          title: h.title,
          content: h.content.slice(0, 2000),
          score: h.score,
          source: h.source ?? null,
        })),
      }
    },
  )
}
