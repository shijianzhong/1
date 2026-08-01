import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './Dialog'
import { Button } from './Button'

// —— 全局确认对话框（替换 window.confirm：原生弹窗在 Electron 里样式违和且阻塞渲染进程）——
// 命令式 API：const ok = await confirmDialog({ title, danger: true })
// 模块级单例 store + <ConfirmHost />（App 根部挂一次）。

export interface ConfirmOptions {
  /** 标题（通常是确认问题，如「确认删除？此操作不可撤销。」） */
  title: string
  /** 补充说明（可选） */
  description?: string
  /** 确认按钮文案（默认「确认」） */
  confirmText?: string
  /** 取消按钮文案（默认「取消」） */
  cancelText?: string
  /** 危险操作（确认按钮用 danger 红色，默认 true——确认框多用于删除类场景） */
  danger?: boolean
}

interface ConfirmRequest extends ConfirmOptions {
  resolve: (ok: boolean) => void
}

let current: ConfirmRequest | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** 弹出确认对话框，resolve 用户选择（确认 true / 取消或关闭 false） */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  // 已有弹窗时先按「取消」结算旧的（调用方不应并发弹确认框，兜底防 Promise 悬挂）
  if (current) settle(false)
  return new Promise<boolean>((resolve) => {
    current = { ...opts, resolve }
    emit()
  })
}

function settle(ok: boolean): void {
  const req = current
  current = null
  emit()
  req?.resolve(ok)
}

/** 挂载点：渲染当前确认请求（App 根部挂一次） */
export function ConfirmHost(): React.JSX.Element {
  const req = useSyncExternalStore(subscribe, () => current)
  const { t } = useTranslation('common')

  return (
    <Dialog open={req !== null} onOpenChange={(open) => { if (!open) settle(false) }}>
      <DialogContent hideClose className="max-w-sm">
        {req ? (
          <>
            <DialogTitle>{req.title}</DialogTitle>
            {req.description ? <DialogDescription className="mt-2">{req.description}</DialogDescription> : null}
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => settle(false)}>
                {req.cancelText ?? t('actions.cancel')}
              </Button>
              <Button
                variant={req.danger === false ? 'default' : 'danger'}
                size="sm"
                onClick={() => settle(true)}
              >
                {req.confirmText ?? t('actions.ok')}
              </Button>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
