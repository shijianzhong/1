import { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/Dialog'
import { Button } from './ui/Button'
import { unwrap } from '@renderer/api/client'

// —— 崩溃恢复对话框（§11.7）——
// 主进程启动时检测 .running 哨兵 → 推 app:crashRecovery 事件；
// preload 缓存 + listDrafts pull 双通道，避免 React 订阅晚于 did-finish-load 丢事件。

interface DraftItem {
  name: string
  content: string
}

export function CrashRecoveryDialog(): React.JSX.Element {
  const { t } = useTranslation('common')
  const [drafts, setDrafts] = useState<DraftItem[]>([])

  useEffect(() => {
    let cancelled = false
    // pull：不依赖 push 时序
    void window.one.app
      .listDrafts()
      .then(unwrap)
      .then((list) => {
        if (!cancelled && list.length > 0) setDrafts(list)
      })
      .catch(() => undefined)

    const unsub = window.one.app.onCrashRecovery((payload) => {
      if (payload.drafts.length > 0) {
        setDrafts(payload.drafts)
      }
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  const handleDismiss = useCallback(async (name: string) => {
    try {
      await window.one.app.removeDraft(name).then(unwrap)
    } catch {
      // 仍从 UI 移除，避免卡死；下次 list 会再出现若删失败
    }
    setDrafts((prev) => prev.filter((d) => d.name !== name))
  }, [])

  const handleDismissAll = useCallback(async () => {
    await Promise.all(
      drafts.map((d) => window.one.app.removeDraft(d.name).then(unwrap).catch(() => undefined)),
    )
    setDrafts([])
  }, [drafts])

  const handleCopy = useCallback((content: string) => {
    navigator.clipboard.writeText(content).catch(() => {})
  }, [])

  const open = drafts.length > 0

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) setDrafts([]) }}>
      <DialogContent className="max-w-lg">
        <DialogTitle>{t('crashRecovery.title')}</DialogTitle>
        <DialogDescription className="mt-2">
          {t('crashRecovery.description')}
        </DialogDescription>

        <div className="mt-4 max-h-[40vh] space-y-3 overflow-y-auto">
          {drafts.map((draft) => (
            <div
              key={draft.name}
              className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-2)] p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-[var(--color-fg-1)] truncate">
                  {draft.name}
                </span>
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleCopy(draft.content)}
                  >
                    {t('crashRecovery.copy')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleDismiss(draft.name)}
                  >
                    {t('crashRecovery.dismiss')}
                  </Button>
                </div>
              </div>
              <pre className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-xs text-[var(--color-fg-2)] font-mono leading-relaxed">
                {draft.content.slice(0, 500)}
                {draft.content.length > 500 ? '\n…' : ''}
              </pre>
            </div>
          ))}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => void handleDismissAll()}>
            {t('crashRecovery.dismissAll')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDrafts([])}>
            {t('actions.close')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
