import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Copy, Download } from 'lucide-react'
import type { Session } from '@shared/types'
import { Drawer, DrawerContent, DrawerTitle } from '@renderer/components/ui/Drawer'
import { Button } from '@renderer/components/ui/Button'
import { Markdown } from '@renderer/components/Markdown'
import { thenUnwrap } from '@renderer/api/hooks'

interface Props {
  /** 待导出会话；为 null 时抽屉隐藏 */
  session: Session | null
  open: boolean
  onClose: () => void
}

// —— 会话导出抽屉（§亮点②：会话导出与回放）——
// 打开时拉取 Markdown 预览，支持「复制全文」与「下载 .md」（主进程弹保存框 + 原子落盘）。
export function SessionExportDrawer({ session, open, onClose }: Props) {
  const { t } = useTranslation(['common'])
  const [savedPath, setSavedPath] = useState<string | null>(null)
  const [copyDone, setCopyDone] = useState(false)

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['sessionExport', session?.id],
    enabled: open && !!session,
    queryFn: () => thenUnwrap(window.one.sessions.export(session!.id)),
  })

  const handleCopy = () => {
    if (!data) return
    navigator.clipboard.writeText(data).then(() => {
      setCopyDone(true)
      setTimeout(() => setCopyDone(false), 2000)
    })
  }

  const handleDownload = async () => {
    if (!session) return
    try {
      const path = await thenUnwrap(window.one.sessions.exportFile(session.id, session.title))
      setSavedPath(path)
    } catch {
      setSavedPath(null)
    }
  }

  return (
    <Drawer open={open} onOpenChange={(v) => !v && onClose()}>
      <DrawerContent width={680}>
        <DrawerTitle>
          {t('common:export.title')}
          {session ? ` · ${session.title}` : ''}
        </DrawerTitle>

        <div className="flex items-center gap-2 mt-4 mb-3">
          <Button variant="ghost" size="sm" onClick={handleCopy} disabled={!data}>
            <Copy size={14} />
            {copyDone ? t('common:code.copied') : t('common:export.copy')}
          </Button>
          <Button size="sm" onClick={handleDownload} disabled={!session}>
            <Download size={14} />
            {t('common:export.download')}
          </Button>
          <button type="button" className="ml-auto text-xs text-[var(--color-fg-3)]" onClick={() => void refetch()}>
            {t('common:actions.retry')}
          </button>
        </div>

        {savedPath ? (
          <p className="text-xs text-[var(--color-success)] mb-2">{t('common:export.saved', { path: savedPath })}</p>
        ) : null}

        <div className="overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg-1)] p-4 h-[calc(100vh-200px)]">
          {isLoading ? (
            <p className="text-sm text-[var(--color-fg-3)]">{t('common:state.loading')}</p>
          ) : isError ? (
            <p className="text-sm text-[var(--color-error)]">
              {t('common:export.failed', { message: (error as Error)?.message ?? '' })}
            </p>
          ) : data ? (
            <Markdown>{data}</Markdown>
          ) : (
            <p className="text-sm text-[var(--color-fg-3)]">{t('common:export.empty')}</p>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  )
}
