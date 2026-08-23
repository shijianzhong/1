// —— 原生对话框文案 schema（铁律 T2：主进程不硬编码中文，review #27）——
// 渲染层 i18n 翻译后经 IPC 传入；主进程 Zod 校验 + 限长，防畸形串进系统弹窗。
// 文件选择版：skills:pickFile / kb:pickFile / theme:pickBackground；
// 目录选择版：registry:applyExport。
import { z } from 'zod'
import { IpcErrorThrow } from '@shared/types'
import type { NativeDirDialogLabels, NativeFileDialogLabels } from '@shared/types'
import { logger } from '../logger'

// title 上限统一 100：文件版/目录版最终都进同一个 Electron dialog.showOpenDialog
// title 字段，不应差异化（此前目录版 max(200) 是无依据分歧，review 发现 #7）。
export const NativeFileDialogLabelsSchema = z.object({
  title: z.string().min(1).max(100),
  fileLabel: z.string().min(1).max(50),
  allFilesLabel: z.string().min(1).max(50),
})

export const NativeDirDialogLabelsSchema = z.object({
  title: z.string().min(1).max(100),
})

export function parseFileDialogLabels(raw: unknown, errKey: string): NativeFileDialogLabels {
  try {
    return NativeFileDialogLabelsSchema.parse(raw) as NativeFileDialogLabels
  } catch (e) {
    // ZodError 原生无 i18n messageKey；记日志便于主进程侧追溯超长/畸形入参，
    // 对用户仍抛结构化 errKey 让渲染层翻译（铁律 T2）。
    logger.warn('[ipc] dialog labels 校验失败', e)
    throw new IpcErrorThrow(errKey)
  }
}

export function parseDirDialogLabels(raw: unknown, errKey: string): NativeDirDialogLabels {
  try {
    return NativeDirDialogLabelsSchema.parse(raw) as NativeDirDialogLabels
  } catch (e) {
    logger.warn('[ipc] dir dialog labels 校验失败', e)
    throw new IpcErrorThrow(errKey)
  }
}
