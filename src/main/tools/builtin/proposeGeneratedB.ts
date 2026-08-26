import { z } from 'zod'
import { registerTool } from '../registry'
import type { CreateDraft } from '@shared/types'
import { emitPropose, newDraftId, NO_CLAIM_SUCCESS } from './create'

// —— 现场造代码工具（docs/PLUGIN_ARCHITECTURE.md §3"生成形态 B 层" + §5 Stage 3）——
// 主 Agent 调 propose_generated_b 产出 generated/B 代码型工具草稿（带可执行 handler 源码）→
// CreateConfirmCard → 用户确认 → home:confirmCreate（kind='generated_b'）→
// validateGeneratedBSpec 闸门 → saveGeneratedBPlugin + enableBPlugin → onLoad
// （trustedBy=null → 占位工具返 trusted_required；用户去 /plugins 信任后才执行真 handler）。
//
// B = A + 自定义组合逻辑：handler 源码内只能调 ctx.executeTool(白名单 8 动作)，
// 无法 require fs/shell（vm 沙箱不注入）。approvalMode='always'（每次弹审批）。
//
// 工具名 propose_generated_b 与 createRecovery 模板 `propose_${kind}` 对齐
//（proposeToolNameForKind('generated_b') 自动返回 propose_generated_b，createRecovery 零改动）。

/** inputSchema（JSON Schema）宽松校验：要求 type=object；注册点再过 validateGeneratedBSpec */
const InputSchemaJson = z
  .object({
    type: z.literal('object'),
    properties: z.record(z.string(), z.unknown()).optional(),
    required: z.array(z.string()).optional(),
  })
  .describe('LLM 可见入参 schema（JSON Schema，type=object）')

/** 注册 propose_generated_b 工具（不落库，确认才入库——对齐 propose_* 范式） */
export function registerProposeGeneratedBTool(): void {
  registerTool(
    'propose_generated_b',
    '当用户想现场造一个带自定义逻辑的代码工具（如"读多个文件合并去重""先搜知识库再格式化输出"）时调用。'
      + '产出工具草稿（含可执行 handler 源码）并弹出确认卡；仅用户确认后入库。'
      + NO_CLAIM_SUCCESS
      + '必须给出 name/description/inputSchema + handlerSource（一段 JS async 函数体）。'
      + 'handlerSource 约定签名：`async function handler(args, ctx){ ... }`，ctx 只暴露 ctx.executeTool(action, args)，'
      + 'action 必须是只读白名单：file_read/file_search/kb_search/web_search/glob/grep/skill_search/load_skill。'
      + '沙箱不暴露 require/process/fs——handler 无法写盘/起子进程。工具入库后默认"未信任"（调到只返提示），'
      + '用户需在 /plugins 页显式信任并每次调用审批后才执行真 handler。'
      + '一旦诉求要执行命令/写盘/外部副作用，就不是本工具范围。',
    z.object({
      name: z.string().min(1).describe('工具名（注册时加 generated_b/ 前缀作为命名空间）'),
      description: z.string().min(1).describe('工具描述（LLM 可见，决定何时调用）'),
      inputSchema: InputSchemaJson.describe('LLM 可见入参 schema（JSON Schema，type=object）'),
      handlerSource: z.string().min(1).describe(
        '可执行 handler 源码（JS async 函数体，不包含外层 function 声明）。'
          + '示例：`const r = await ctx.executeTool("file_read", { path: "package.json" }); return JSON.parse(r.content).name`',
      ),
    }),
    async (args, ctx) => {
      const a = args as {
        name: string
        description: string
        inputSchema: Record<string, unknown>
        handlerSource: string
      }
      const draft: CreateDraft = {
        draftId: newDraftId(),
        kind: 'generated_b',
        payload: {
          name: a.name,
          description: a.description,
          inputSchema: a.inputSchema,
          handlerSource: a.handlerSource,
        },
      }
      return emitPropose(ctx, draft)
    },
  )
}
