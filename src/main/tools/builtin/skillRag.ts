import { z } from 'zod'
import { getSkill } from '../../storage/models'
import { searchSkills } from '../../storage/skills/fts'
import { getSkillRootDir, listSkillScripts } from '../../skills/provider'
import { registerTool } from '../registry'

export function registerSkillRagTools(): void {
  registerTool(
    'skill_search',
    '按任务关键词检索已安装技能。适用于写作、设计、数据处理、自动化等需要专门技能说明的任务；先搜索，再按 id 用 load_skill 取完整说明。闲聊或通用问答不要调用。',
    z.object({
      keywords: z.string().describe('任务关键词，越贴近技能用途越准'),
      limit: z.number().int().positive().max(20).optional().describe('返回上限，默认 8'),
    }),
    async (args) => {
      const { keywords, limit } = args as { keywords: string; limit?: number }
      return searchSkills(keywords, limit ?? 8)
    },
  )

  registerTool(
    'load_skill',
    '按 id 读取技能完整说明。通常先用 skill_search 拿到 id，再用本工具取回 content、discipline 和可执行脚本清单。',
    z.object({
      id: z.string().describe('技能 id（来自 skill_search 返回结果）'),
    }),
    async (args) => {
      const { id } = args as { id: string }
      const skill = getSkill(id)
      if (!skill) {
        return {
          ok: false,
          error: 'skill_not_found',
          messageKey: 'errors.tools.skill_not_found',
        }
      }
      return {
        id: skill.id,
        name: skill.name,
        content: skill.content,
        discipline: skill.discipline,
        scripts: listSkillScripts(getSkillRootDir(skill.id)),
      }
    },
  )
}
