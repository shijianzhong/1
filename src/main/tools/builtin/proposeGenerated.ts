import { z } from 'zod'
import { registerTool } from '../registry'
import type { CreateDraft } from '@shared/types'
import { emitPropose, newDraftId, NO_CLAIM_SUCCESS } from './create'
import { WHITELIST_ACTIONS } from '../../plugins/whitelist'

// —— 现场造工具（docs/PLUGIN_ARCHITECTURE.md §3"生成形态 A 层" + §5 Stage 2）——
// 主 Agent 调 propose_generated 产出 generated/A 声明式工具草稿（只读/检索白名单动作）→
// CreateConfirmCard → 用户确认 → home:confirmCreate（kind='generated'）→
// saveGeneratedPlugin + GeneratedPlugin.onLoad 注册 → listAgentToolDefs 收录 → 可被 LLM 调用。
//
// 工具名 propose_generated 与 createRecovery 的模板 `propose_${kind}` 对齐
//（proposeToolNameForKind('generated') 自动返回 propose_generated，createRecovery 零改动）。

/** executeAction 子 schema（action 必须是白名单 enum） */
const ExecuteActionSchema = z.object({
  action: z.enum(WHITELIST_ACTIONS).describe(
    '判发目标动作（只读/检索白名单）：file_read/file_search/kb_search/web_search/glob/grep/skill_search/load_skill',
  ),
  params: z.record(z.string(), z.unknown()).optional().describe(
    '固定参数（与运行时 args 合并后透传给目标动作）。须是该动作既有 schema 的 pick/subset，注册点强校验。',
  ),
})

/** inputSchema（JSON Schema）宽松校验：要求 type=object + properties；注册点再过 validateGeneratedSpec */
const InputSchemaJson = z
  .object({
    type: z.literal('object'),
    properties: z.record(z.string(), z.unknown()).optional(),
    required: z.array(z.string()).optional(),
  })
  .describe('LLM 可见入参 schema（JSON Schema，type=object）')

/** 注册 propose_generated 工具（不落库，确认才入库——对齐 propose_* 范式） */
export function registerProposeGeneratedTool(): void {
  registerTool(
    'propose_generated',
    '当用户想现场造一个无副作用工具（只读/检索类，如"读某文件按模板整理""搜知识库汇成结论"）时调用。'
      + '产出工具草稿并弹出确认卡；仅用户确认后注册进 registry 被 LLM 调用。'
      + NO_CLAIM_SUCCESS
      + '必须给出 name/description/inputSchema(JSON Schema) + executeAction(白名单 action + 可选固定 params)。'
      + '一旦诉求要执行命令/写盘/外部副作用，就不是本工具范围（走既有 approval 闸门或 shell）。',
    z.object({
      name: z.string().min(1).describe('工具名（注册时加 generated/ 前缀作为命名空间）'),
      description: z.string().min(1).describe('工具描述（LLM 可见，决定何时调用）'),
      inputSchema: InputSchemaJson.describe('LLM 可见入参 schema（JSON Schema，type=object）'),
      executeAction: ExecuteActionSchema.describe('判发目标：白名单动作 + 可选固定 params'),
    }),
    async (args, ctx) => {
      const a = args as {
        name: string
        description: string
        inputSchema: Record<string, unknown>
        executeAction: { action: string; params?: Record<string, unknown> }
      }
      const draft: CreateDraft = {
        draftId: newDraftId(),
        kind: 'generated',
        payload: {
          name: a.name,
          description: a.description,
          inputSchema: a.inputSchema,
          executeAction: a.executeAction,
        },
      }
      return emitPropose(ctx, draft)
    },
  )
}
