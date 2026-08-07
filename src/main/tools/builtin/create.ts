import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { registerTool } from '../registry'
import type { CreateDraft, WorkflowGraph } from '@shared/types'

// —— 聊天创建工具（主 Agent 经 propose_* 产出草稿，**不落库**）——
// 设计（见 home 创建闭环 + docs/CHAT_CREATE_PERSISTENCE_FIX.md）：工具只构造 CreateDraft
// 并经 toolCtx 回调推给 home IPC → emitStream proposal → 前端确认卡。
// 落库发生在用户确认后（home:confirmCreate），此处绝不直接 save*。

/** 由 home.ts 注入到 toolCtx 的提案回调（工具 → IPC 的桥） */
export interface ProposeSink {
  onPropose?: (draft: CreateDraft) => void
}

function newDraftId(): string {
  return `draft_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

const GraphNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['agent', 'sequential', 'concurrent', 'groupchat', 'handoff', 'magentic']),
  data: z.record(z.string(), z.unknown()),
  position: z.object({ x: z.number(), y: z.number() }),
})
const GraphEdgeSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  condition: z.string().optional(),
})
const WorkflowGraphSchema = z.object({
  nodes: z.array(GraphNodeSchema).min(1),
  edges: z.array(GraphEdgeSchema),
})

/** 四类工具共用的防幻觉尾句（A1 对称） */
const NO_CLAIM_SUCCESS =
  '调用本工具仅弹出确认卡，不等于已入库。禁止向用户宣称创建成功/已保存/已入库；须待用户在卡片上确认。'

function emitPropose(ctx: unknown, draft: CreateDraft): { ok: true; draftId: string; kind: string } {
  const sink = ctx as ProposeSink | undefined
  sink?.onPropose?.(draft)
  return { ok: true, draftId: draft.draftId, kind: draft.kind }
}

/** 注册聊天创建工具（propose_*，不落库） */
export function registerCreateTools(): void {
  registerTool(
    'propose_agent',
    '当用户想创建/新增一个角色（Agent）时调用。产出角色草稿并弹出确认卡；仅当用户点「确认入库」后才会写入角色库。'
      + NO_CLAIM_SUCCESS
      + '需先澄清角色定位与职责，再产出 name 与 instructions。',
    z.object({
      name: z.string().describe('角色名称（简短、表意）'),
      description: z.string().optional().describe('一句话描述角色定位'),
      instructions: z.string().describe('角色 system prompt：定义人格、职责、输出风格'),
      outputConstraints: z.string().optional().describe('输出约束（如"≤200字"）'),
      temperature: z.number().min(0).max(2).optional().describe('采样温度'),
      maxTokens: z.number().int().positive().optional().describe('最大输出 token'),
    }),
    async (args, ctx) => {
      const a = args as {
        name: string
        description?: string
        instructions: string
        outputConstraints?: string
        temperature?: number
        maxTokens?: number
      }
      const draft: CreateDraft = {
        draftId: newDraftId(),
        kind: 'agent',
        payload: {
          name: a.name,
          description: a.description,
          instructions: a.instructions,
          outputConstraints: a.outputConstraints,
          temperature: a.temperature,
          maxTokens: a.maxTokens,
        },
      }
      return emitPropose(ctx, draft)
    },
  )

  registerTool(
    'propose_capability',
    '当用户想创建/新增一个能力（多角色编排工作流）时调用。产出能力草稿（含编排图 graph）并弹出确认卡；仅用户确认后入库。'
      + NO_CLAIM_SUCCESS
      + '必须产出通过校验的 graph（nodes 至少 1 个）；校验失败不会弹卡。需先澄清能力目标、参与角色与协作模式。',
    z.object({
      name: z.string().describe('能力名称'),
      description: z.string().optional().describe('一句话描述能力用途'),
      graph: WorkflowGraphSchema.describe(
        '编排图：nodes（agent 引用或编排容器）+ edges（连线）。agent 节点 data 需含 label/instructions 或引用已有角色；容器节点按模式含 participantIds/aggregatorId 等。',
      ),
    }),
    async (args, ctx) => {
      const a = args as { name: string; description?: string; graph: WorkflowGraph }
      const draft: CreateDraft = {
        draftId: newDraftId(),
        kind: 'capability',
        payload: { name: a.name, description: a.description, graph: a.graph },
      }
      return emitPropose(ctx, draft)
    },
  )

  registerTool(
    'propose_skill',
    '当用户想创建/新增一个技能（Skill，SKILL.md 知识与纪律）时调用。产出技能草稿并弹出确认卡；仅用户确认后入库。'
      + NO_CLAIM_SUCCESS
      + '需先澄清技能用途与内容，再产出 name 与 content。',
    z.object({
      name: z.string().describe('技能名称'),
      description: z.string().optional().describe('一句话描述技能用途'),
      content: z.string().describe('SKILL.md 内容（知识/流程/约定，Markdown）'),
      discipline: z.string().optional().describe('输出纪律段（约束 agent 使用该技能时的行为）'),
    }),
    async (args, ctx) => {
      const a = args as { name: string; description?: string; content: string; discipline?: string }
      const draft: CreateDraft = {
        draftId: newDraftId(),
        kind: 'skill',
        payload: {
          name: a.name,
          description: a.description,
          content: a.content,
          discipline: a.discipline,
        },
      }
      return emitPropose(ctx, draft)
    },
  )

  registerTool(
    'propose_persona',
    '当用户想修改主助手的人设（人格、语气、职责定位）或更新用户档案（称呼/角色/偏好语种）时调用。产出草稿并弹出确认卡；仅用户确认后入库。'
      + NO_CLAIM_SUCCESS
      + '改人设时 instructions 传完整新正文（全量替换）；只改档案时 instructions 不传。',
    z.object({
      instructions: z.string().optional().describe('新的主助手人设正文（完整版，全量替换）。只改档案时不传。'),
      alias: z.string().optional().describe('可选：更新用户称呼'),
      role: z.string().optional().describe('可选：更新用户角色描述'),
      preferredLanguage: z.enum(['zh-CN', 'en']).optional().describe('可选：更新偏好回复语种'),
    }),
    async (args, ctx) => {
      const a = args as {
        instructions?: string
        alias?: string
        role?: string
        preferredLanguage?: 'zh-CN' | 'en'
      }
      const hasProfile = a.alias !== undefined || a.role !== undefined || a.preferredLanguage !== undefined
      if (!a.instructions?.trim() && !hasProfile) {
        return {
          ok: false,
          error: 'empty_payload',
          messageKey: 'errors.create.empty_payload',
          hint: '至少传 instructions 或一个档案字段（alias/role/preferredLanguage）',
        }
      }
      const draft: CreateDraft = {
        draftId: newDraftId(),
        kind: 'persona',
        payload: {
          ...(a.instructions?.trim() ? { instructions: a.instructions } : {}),
          ...(hasProfile
            ? {
                profile: {
                  alias: a.alias,
                  role: a.role,
                  preferredLanguage: a.preferredLanguage,
                },
              }
            : {}),
        },
      }
      return emitPropose(ctx, draft)
    },
  )
}
