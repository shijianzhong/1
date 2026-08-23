import { describe, expect, it, vi } from 'vitest'

const warn = vi.fn()

vi.mock('../logger', () => ({
  logger: { error: vi.fn(), warn: (...a: unknown[]) => warn(...a), info: vi.fn() },
}))

import { IpcErrorThrow } from '@shared/types'
import { parseDirDialogLabels, parseFileDialogLabels } from './dialog-labels'

describe('ipc/dialog-labels', () => {
  const fileOk = { title: '选择背景图片', fileLabel: '图片', allFilesLabel: '所有文件' }
  const dirOk = { title: '选择导出目录' }
  const errKey = 'errors:theme.invalid_input'

  it('parseFileDialogLabels 合法内容原样返回', () => {
    expect(parseFileDialogLabels(fileOk, errKey)).toEqual(fileOk)
  })

  it('parseDirDialogLabels 合法内容原样返回', () => {
    expect(parseDirDialogLabels(dirOk, 'errors:registry.invalid_input')).toEqual(dirOk)
  })

  it('剥离未知键（防畸形串进系统弹窗）', () => {
    expect(parseFileDialogLabels({ ...fileOk, extra: 'ignored' }, errKey)).toEqual(fileOk)
  })

  it('title 为空串（min(1)）抛 IpcErrorThrow 且归一化 messageKey', () => {
    warn.mockClear()
    let thrown: unknown
    try {
      parseFileDialogLabels({ ...fileOk, title: '' }, 'errors.registry.invalid_input')
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(IpcErrorThrow)
    expect((thrown as IpcErrorThrow).messageKey).toBe('errors:registry.invalid_input')
    expect(warn).toHaveBeenCalledOnce()
  })

  it('title 超长（max(100)）抛 IpcErrorThrow', () => {
    const tooLong = 'x'.repeat(101)
    expect(() => parseFileDialogLabels({ ...fileOk, title: tooLong }, errKey)).toThrow(IpcErrorThrow)
  })

  it('fileLabel 超长（max(50)）抛 IpcErrorThrow', () => {
    const tooLong = 'x'.repeat(51)
    expect(() => parseFileDialogLabels({ ...fileOk, fileLabel: tooLong }, errKey)).toThrow(IpcErrorThrow)
  })

  it('目录版 title 超长（max(100)）抛 IpcErrorThrow', () => {
    const tooLong = 'x'.repeat(101)
    expect(() => parseDirDialogLabels({ title: tooLong }, 'errors:registry.invalid_input')).toThrow(
      IpcErrorThrow,
    )
  })

  it('非对象入参（undefined）抛 IpcErrorThrow', () => {
    expect(() => parseFileDialogLabels(undefined, errKey)).toThrow(IpcErrorThrow)
  })
})
