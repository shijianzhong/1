import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { registerTool } from '../registry'
import type { CreateDraft, WorkflowGraph } from '@shared/types'

// —— 聊天创建工具（主 Agent 经 propose_* 产出草稿，**不落库**）——
// 设计（见 home 创建闭环）：工具只构造 CreateDraft 并经 toolCtx 回调推给 home IPC
// → emitStream proposal → 前端确认卡。落库发生在用户确认后（home:confirmCreate），
// 此处绝不直接 save*，保证「确认入库才入库」。
//
// draft 暂存：工具 handler 把 draft 塞进 ctx 上的 onPropose 回调（由 home.ts 注入），
// home.ts 据此 emitStream。返回值仅回 { ok, draftId, kind } 给 LLM 确认提案已发出。

/** 由 home.ts 注入到 toolCtx 的提案回调（工具 → IPC 的桥） */
export interface ProposeSink {
  onPropose?: (draft: CreateDraft) => void
}

function newDraftId(): string {
  return `draft_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

// —— graph 运行时校验（capability 用；LLM 生成的 graph 须合法才能渲染预览/入库）——
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

function emitPropose(ctx: unknown, draft: CreateDraft): { ok: true; draftId: string; kind: string } {
  const sink = ctx as ProposeSink | undefined
  sink?.onPropose?.(draft)
  return { ok: true, draftId: draft.draftId, kind: draft.kind }
}

/** 注册聊天创建工具（propose_*，不落库） */
export function registerCreateTools(): void {
  registerTool(
    'propose_agent',
    '当用户想创建/新增一个角色（Agent）时调用。产出角色草稿供用户确认，确认后才入库。需先与用户澄清角色定位与职责，再产出 name 与 instructions。',
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
    '当用户想创建/新增一个能力（多角色编排工作流）时调用。产出能力草稿（含编排图 graph JSON）供用户确认，确认后才入库。需先与用户澄清能力目标、参与角色与协作模式，再产出 name 与合法 graph。',
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
    '当用户想创建/新增一个技能（Skill，SKILL.md 知识与纪律）时调用。产出技能草稿供用户确认，确认后才入库。需先与用户澄清技能用途与内容，再产出 name 与 content。',
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
}
