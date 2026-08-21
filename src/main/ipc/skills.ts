import { dialog } from 'electron'
import { z } from 'zod'
import type { NativeFileDialogLabels, Skill, SkillMeta } from '@shared/types'
import { IpcErrorThrow } from '@shared/types'
import { withHandler } from './handler'
import { getSkill, getSkillDir, invalidateSkillsCache, listSkillMetas, removeSkill, saveSkill } from '../storage/models'
import { extractSkillResourcesToDir, uploadSkillFile } from '../skills/upload'
import { logger } from '../logger'

/** 原生对话框文案（渲染层 i18n 传入；限长防畸形串进系统弹窗） */
const NativeFileDialogLabelsSchema = z.object({
  title: z.string().min(1).max(100),
  fileLabel: z.string().min(1).max(50),
  allFilesLabel: z.string().min(1).max(50),
})

// —— 技能 IPC（§八之二 B）——
// 目录化改造（docs/SKILL_STORAGE_STANDARD_PLAN.md §6.8）：
// pickFile 合并解析+保存+资源提取，一步到位返回完整 Skill。
export function registerSkillsHandlers(): void {
  withHandler<SkillMeta[]>('skills:list', () => listSkillMetas())
  withHandler<Skill | null>('skills:get', (_e, id) => getSkill(id as string))
  withHandler<Skill>('skills:save', (_e, input) => saveSkill(input))
  withHandler<void>('skills:remove', (_e, id) => removeSkill(id as string))

  // 上传技能包：弹原生文件选择框 → 解析 ZIP → saveSkill 落盘 → 提取资源 → 返回完整 Skill
  // 对话框文案由渲染层 i18n 后传入（铁律 T2：主进程不硬编码中文，review #27）
  withHandler<Skill | null>('skills:pickFile', async (_e, labelsRaw) => {
    let labels: NativeFileDialogLabels
    try {
      labels = NativeFileDialogLabelsSchema.parse(labelsRaw) as NativeFileDialogLabels
    } catch {
      throw new IpcErrorThrow('errors:skills.invalid_input')
    }
    const result = await dialog.showOpenDialog({
      title: labels.title,
      properties: ['openFile'],
      filters: [
        { name: labels.fileLabel, extensions: ['zip'] },
        { name: labels.allFilesLabel, extensions: ['*'] },
      ],
    })

    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]

    const parsed = await uploadSkillFile(filePath)
    const saved = saveSkill({
      name: parsed.name,
      description: parsed.description,
      tags: parsed.tags,
      content: parsed.content,
      discipline: parsed.discipline,
    })
    // 提取 scripts/resources 到 skill 目录（目录化标准格式，直接落最终位置）
    // 失败时回滚：删除已落盘的 SKILL.md，防残缺 skill 残留
    try {
      await extractSkillResourcesToDir(filePath, getSkillDir(saved.id), parsed)
    } catch (error) {
      logger.warn(`[skills:pickFile] 资源提取失败，回滚 skill ${saved.id}`, error)
      removeSkill(saved.id)
      throw error
    }
    // extract 直接改目录不走 save/remove，须显式失效缓存，
    // 防 listSkillMetas 读到 extract 前的中间态（hasScripts=false）驻留
    invalidateSkillsCache()
    return getSkill(saved.id) ?? saved
  })
}
