import { z } from 'zod'
import { registerTool } from '../registry'

// —— 内置 HITL 工具（对照原框架 request_user_input function tool）——
// 编排内 agent 缺少关键信息时向用户提问：工具挂起等待，用户作答作 tool_result 返回。
// 仅交互式运行注入 onAskUser（首页组队/编辑器运行）；非交互环境（未来后台任务）
// 未注入 → 返回 user_input_unavailable 错误 JSON，LLM 自行推断继续（铁律11 不抛）。
//
// description 行为导向（与 memory_* 同策略）：明确「何时该问/何时别问」，
// 否则 LLM 要么滥用打断用户，要么从不提问形同虚设。

export function registerAskUserTools(): void {
  registerTool(
    'ask_user',
    '向用户提问并等待回答，用于缺少完成任务所必需的关键信息（缺失参数/用户偏好/方案抉择/风险确认）且无法从上下文推断时。规则：能自行合理推断的不要问；一次只问最关键的一两个问题；不要问用户已回答过的；提问后流程会暂停等待用户作答，答案会作为工具结果返回。',
    z.object({
      question: z.string().describe('要问用户的问题：具体、一句话可作答'),
      context: z
        .string()
        .optional()
        .describe('补充背景（为什么需要这个信息/当前进展），帮助用户理解决策点'),
    }),
    async (args, ctx) => {
      const { question, context } = args as { question: string; context?: string }
      if (!ctx.onAskUser) {
        return {
          ok: false,
          error: 'user_input_unavailable',
          hint: '当前环境无法与用户交互，请基于已有信息自行合理推断并继续',
        }
      }
      try {
        const answer = await ctx.onAskUser({ question, context })
        return { ok: true, answer }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return {
          ok: false,
          error: msg,
          hint: '用户未作答（超时或运行被取消），请基于已有信息继续；若信息确实不可或缺，说明原因后给出当前能给的最佳结果',
        }
      }
    },
  )
}
