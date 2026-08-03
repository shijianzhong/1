import { dialog } from 'electron'
import type { Skill } from '@shared/types'
import { withHandler } from './handler'
import { getSkill, listSkills, removeSkill, saveSkill } from '../storage/models'
import { uploadSkillFile } from '../skills/upload'

// —— 技能 IPC（§八之二 B）——
export function registerSkillsHandlers(): void {
  withHandler<Skill[]>('skills:list', () => listSkills())
  withHandler<Skill | null>('skills:get', (_e, id) => getSkill(id as string))
  withHandler<Skill>('skills:save', (_e, input) => saveSkill(input))
  withHandler<void>('skills:remove', (_e, id) => removeSkill(id as string))

  // 上传技能包：弹原生文件选择框 → 解析 ZIP → 返回 ParsedSkill
  // 调用方拿到结果后再调 skills:save 落盘
  withHandler<{
    name: string
    description?: string
    content: string
    discipline?: string
    scriptPath?: string
  } | null>('skills:pickFile', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择技能包',
      properties: ['openFile'],
      filters: [
        { name: '技能包', extensions: ['zip'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })

    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]

    const { parsed, scriptPath } = await uploadSkillFile(filePath)
    return {
      name: parsed.name,
      description: parsed.description,
      content: parsed.content,
      discipline: parsed.discipline,
      scriptPath,
    }
  })
}
