import { z } from 'zod'
import { registerTool } from '../registry'
import {
  createTopic,
  getTopic,
  getSampleArticle,
  saveSampleArticle,
  getStyleProfile,
  saveStyleProfile,
} from '../../storage/models'
import type { TopicMeta, TopicRecommendation, TopicStatus, StyleProfile } from '@shared/types'

// —— 资产库 CRUD 工具（内容生产 §2.4，agent 读写知识资产）——
// 与 review_archive_save 同范式：工具不经 IPC，agent 自动从 registry 取。
// 选题库（topics 表）、样文（目录化）、风格画像（JsonCollection）三类资产的读写。
// 读工具返回纯数据，写工具返回落库后的实体。错误返回 JSON 不抛（铁律11）。

export function registerAssetCrudTools(): void {
  // —— 选题库 ——
  registerTool(
    'topic_add',
    '把一个调研通过三维过筛的选题追加进选题库（SQLite topics 表）。写明方向、标题、推荐度、价值评估（热度信号/搜索价值/对标空白/判断结论/切口）。阶段1 A1 调研员收敛后调用。',
    z.object({
      title: z.string().describe('选题标题/切口'),
      direction: z.string().describe('方向（AI全谱/前端工程/程序员职场副业/自定义）'),
      recommendation: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().describe('推荐度 1-3'),
      status: z
        .enum(['pending', 'researching', 'producing', 'published', 'archived'])
        .optional()
        .describe('状态，默认 pending'),
      meta: z
        .object({
          heatSignal: z.string().optional(),
          searchValue: z.string().optional(),
          benchmarkGap: z.string().optional(),
          verdict: z.string().optional(),
          angle: z.string().optional(),
          altAngles: z.array(z.string()).optional(),
          triFilter: z
            .object({
              heat: z.boolean().optional(),
              redSea: z.boolean().optional(),
              blank: z.boolean().optional(),
            })
            .optional(),
        })
        .optional(),
      tags: z.array(z.string()).optional(),
    }),
    async (args) => {
      const input = args as {
        title: string
        direction?: string
        recommendation?: TopicRecommendation
        status?: TopicStatus
        meta?: TopicMeta
        tags?: string[]
      }
      try {
        const topic = createTopic({
          title: input.title,
          direction: input.direction,
          recommendation: input.recommendation,
          status: input.status,
          meta: input.meta,
          tags: input.tags,
        })
        return { ok: true, topicId: topic.id, title: topic.title }
      } catch (e) {
        return {
          ok: false,
          error: 'write_failed',
          messageKey: 'errors.tools.review_save_failed',
          hint: e instanceof Error ? e.message : String(e),
        }
      }
    },
  )

  registerTool(
    'topic_get',
    '按 id 取选题库中的一个选题（含价值评估 meta）。阶段4 A4 产出前用此取已定选题的方向/切口/判断结论。',
    z.object({ id: z.string().describe('选题 id') }),
    async (args) => {
      const { id } = args as { id: string }
      const topic = getTopic(id)
      if (!topic) return { ok: false, error: 'not_found', hint: `选题 ${id} 不存在` }
      return { ok: true, topic }
    },
  )

  // —— 样文 ——
  registerTool(
    'sample_article_save',
    '把一篇翘楚代表作正文存进样文库（目录化 config/sample-articles/<id>/ARTICLE.md）。阶段2 A2 拆解后调用，每次按"有热度+代表该号风格+和方向相关"筛选，滚动保留约4篇。',
    z.object({
      name: z.string().describe('显示名'),
      content: z.string().describe('文章正文 Markdown'),
      source: z.string().optional().describe('来源号（如码农翻身/量子位）'),
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }),
    async (args) => {
      const input = args as {
        name: string
        content: string
        source?: string
        description?: string
        tags?: string[]
      }
      try {
        const article = saveSampleArticle({
          name: input.name,
          content: input.content,
          source: input.source,
          description: input.description,
          tags: input.tags,
        })
        return { ok: true, articleId: article.id, name: article.name }
      } catch (e) {
        return {
          ok: false,
          error: 'write_failed',
          messageKey: 'errors.tools.review_save_failed',
          hint: e instanceof Error ? e.message : String(e),
        }
      }
    },
  )

  registerTool(
    'sample_article_read',
    '按 id 取样文库中的一篇样文正文。阶段3 A3 风格固化、阶段4 A4 产出对齐时调用。',
    z.object({ id: z.string().describe('样文 id') }),
    async (args) => {
      const { id } = args as { id: string }
      const article = getSampleArticle(id)
      if (!article) return { ok: false, error: 'not_found', hint: `样文 ${id} 不存在` }
      return { ok: true, article }
    },
  )

  // —— 风格画像 ——
  registerTool(
    'style_profile_update',
    '更新或新建风格画像（JsonCollection config/style-profiles/{id}.json）。写入标题公式×N、6段式骨架、语气词表、字数区间、互动钩子、自造说法禁用清单、英译式连接词禁用清单。阶段3 A3 综合拆解所长+样文回填后调用。固化后每次产出套用。',
    z.object({
      id: z.string().optional().describe('画像 id；不填=新建（自动生成）'),
      name: z.string().describe('画像名（如"本号固化风格"）'),
      description: z.string().optional(),
      titleFormulas: z.array(z.string()).optional().describe('标题公式列表'),
      structureSkeleton: z.string().optional().describe('6段式骨架'),
      toneWords: z.array(z.string()).optional().describe('语气词表'),
      wordCountRange: z.string().optional().describe('字数区间'),
      interactionHooks: z.array(z.string()).optional().describe('互动钩子模板'),
      bannedInventedTerms: z.array(z.string()).optional().describe('自造说法禁用清单'),
      bannedEnglishConnections: z.array(z.string()).optional().describe('英译式连接词禁用清单'),
    }),
    async (args) => {
      const input = args as Partial<StyleProfile> & { name: string }
      try {
        const profile = saveStyleProfile({ id: input.id, ...input })
        return { ok: true, profileId: profile.id, name: profile.name }
      } catch (e) {
        return {
          ok: false,
          error: 'write_failed',
          messageKey: 'errors.tools.review_save_failed',
          hint: e instanceof Error ? e.message : String(e),
        }
      }
    },
  )

  registerTool(
    'style_profile_read',
    '取已固化的风格画像（标题公式/骨架/语气词/禁用清单等）。阶段4 A4 产出前调用，套用固化风格写稿。',
    z.object({ id: z.string().describe('画像 id') }),
    async (args) => {
      const { id } = args as { id: string }
      const profile = getStyleProfile(id)
      if (!profile) return { ok: false, error: 'not_found', hint: `风格画像 ${id} 不存在` }
      return { ok: true, profile }
    },
  )
}
