import type { Skill } from '@shared/types'
import { withHandler } from './handler'
import { getSkill, listSkills, removeSkill, saveSkill } from '../storage/models'

// —— 技能 IPC（§八之二 B）——
export function registerSkillsHandlers(): void {
  withHandler<Skill[]>('skills:list', () => listSkills())
  withHandler<Skill | null>('skills:get', (_e, id) => getSkill(id as string))
  withHandler<Skill>('skills:save', (_e, input) => saveSkill(input))
  withHandler<void>('skills:remove', (_e, id) => removeSkill(id as string))
}
