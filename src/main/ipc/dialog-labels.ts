// —— 原生对话框文案 schema（铁律 T2：主进程不硬编码中文，review #27）——
// 渲染层 i18n 翻译后经 IPC 传入；主进程 Zod 校验 + 限长，防畸形串进系统弹窗。
// 文件选择版：skills:pickFile / kb:pickFile / theme:pickBackground；
// 目录选择版：registry:applyExport。
import { z } from 'zod'
import { IpcErrorThrow } from '@shared/types'
import type { NativeDirDialogLabels, NativeFileDialogLabels } from '@shared/types'

export const NativeFileDialogLabelsSchema = z.object({
  title: z.string().min(1).max(100),
  fileLabel: z.string().min(1).max(50),
  allFilesLabel: z.string().min(1).max(50),
})

export const NativeDirDialogLabelsSchema = z.object({
  title: z.string().min(1).max(200),
})

export function parseFileDialogLabels(raw: unknown, errKey: string): NativeFileDialogLabels {
  try {
    return NativeFileDialogLabelsSchema.parse(raw) as NativeFileDialogLabels
  } catch {
    throw new IpcErrorThrow(errKey)
  }
}

export function parseDirDialogLabels(raw: unknown, errKey: string): NativeDirDialogLabels {
  try {
    return NativeDirDialogLabelsSchema.parse(raw) as NativeDirDialogLabels
  } catch {
    throw new IpcErrorThrow(errKey)
  }
}
