import { z } from 'zod'
import { registerTool } from '../registry'

// —— update_plan（任务计划 Task 6）——
// 规划工具：agent 拆任务、追踪进度。状态存内存 Map（sessionId 键），
// 不持久化——任务计划是运行期临时产物，崩溃重启后重新规划是合理行为。

export interface PlanStep {
  step: string
  status: 'pending' | 'in_progress' | 'completed'
}

const planStore = new Map<string, PlanStep[]>()

const UpdatePlanSchema = z.object({
  explanation: z.string().optional().describe('对计划变更的简要说明'),
  plan: z
    .array(
      z.object({
        step: z.string().min(1).describe('步骤描述'),
        status: z.enum(['pending', 'in_progress', 'completed']),
      }),
    )
    .min(1)
    .describe('完整计划（含已完成的步骤，全量替换）'),
})

export function registerPlanTools(): void {
  registerTool(
    'update_plan',
    '创建或更新任务执行计划。复杂任务先拆解为步骤，每完成一步标记 completed。计划全量替换，不要在正文重复计划内容。',
    UpdatePlanSchema,
    (args, ctx) => {
      const input = args as z.infer<typeof UpdatePlanSchema>
      const key = ctx?.sessionId ?? '__default__'
      planStore.set(key, input.plan)
      return {
        ok: true,
        plan: input.plan,
        explanation: input.explanation,
      }
    },
  )
}

/** 读当前会话计划（供 prompt 注入或调试） */
export function getPlan(sessionId?: string): PlanStep[] {
  return planStore.get(sessionId ?? '__default__') ?? []
}

/** 清空计划（测试用） */
export function clearPlans(): void {
  planStore.clear()
}
