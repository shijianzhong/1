import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleAlert, FolderCheck, GitPullRequest, Share2 } from 'lucide-react'
import type {
  RegistryAssetKind,
  RegistryExportConfirmItem,
  RegistryExportPlan,
  RegistryExportResult,
} from '@shared/types'
import { unwrap } from '@renderer/api/client'
import { useApplyRegistryExport, usePlanRegistryExport } from '@renderer/api/hooks'
import { Button } from '@renderer/components/ui/Button'
import { Input } from '@renderer/components/ui/Input'
import { Badge } from '@renderer/components/ui/Badge'
import { Drawer, DrawerContent, DrawerTitle } from '@renderer/components/ui/Drawer'

// —— 发布到 Registry（docs/REGISTRY_PLAN.md §3.3，Phase 3）——
// 自包含入口：各管理页操作区放一个 <RegistryPublishButton kind localId />，
// 点击 → planExport 级联预览（slug/version 可编辑、依赖可取消勾选）→
// applyExport（主进程弹目录选择 → 落盘 + provenance 回写）→ 引导 fork + PR。

interface EditableItem {
  kind: RegistryAssetKind
  localId: string
  name: string
  slug: string
  version: string
  status: 'new' | 'update'
  auto?: boolean
  include: boolean
}

export function RegistryPublishButton(props: { kind: RegistryAssetKind; localId: string }) {
  const { t } = useTranslation(['registry', 'common'])
  const planExport = usePlanRegistryExport()
  const applyExport = useApplyRegistryExport()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<EditableItem[] | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [result, setResult] = useState<RegistryExportResult | null>(null)
  const [confirmed, setConfirmed] = useState<RegistryExportConfirmItem[]>([])
  const [prUrl, setPrUrl] = useState<string | null>(null)
  const [prPending, setPrPending] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const reset = (): void => {
    setItems(null)
    setWarnings([])
    setResult(null)
    setConfirmed([])
    setPrUrl(null)
    setPrPending(false)
    setErrorMsg(null)
  }

  const onOpen = async (): Promise<void> => {
    reset()
    setOpen(true)
    try {
      const plan: RegistryExportPlan = await planExport.mutateAsync({
        kind: props.kind,
        localId: props.localId,
      })
      setItems(plan.items.map((i) => ({ ...i, include: true })))
      setWarnings(plan.warnings)
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : String(error))
    }
  }

  const patchItem = (idx: number, patch: Partial<EditableItem>): void => {
    setItems((prev) => prev?.map((it, i) => (i === idx ? { ...it, ...patch } : it)) ?? null)
  }

  const onConfirm = async (): Promise<void> => {
    if (!items) return
    setErrorMsg(null)
    const confirmed = items
      .filter((i) => i.include)
      .map(({ kind, localId, slug, version }) => ({ kind, localId, slug: slug.trim(), version: version.trim() }))
    if (confirmed.length === 0) return
    try {
      const r = await applyExport.mutateAsync(confirmed)
      if (r) {
        setResult(r)
        setConfirmed(confirmed)
      } else {
        setOpen(false) // 用户取消目录选择，安静关闭
      }
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : String(error))
    }
  }

  /** 方式 B：GitHub API 自动 fork + PR（§3.3 步骤 4；需写权限 Token，错误信息主进程已分场景） */
  const onSubmitPr = async (): Promise<void> => {
    if (!result || confirmed.length === 0) return
    setPrPending(true)
    setErrorMsg(null)
    try {
      const pr = await window.one.registry
        .submitPr({ dir: result.dir, files: result.files, items: confirmed })
        .then(unwrap)
      setPrUrl(pr.prUrl)
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : String(error))
    } finally {
      setPrPending(false)
    }
  }

  const planning = planExport.isPending
  const applying = applyExport.isPending
  const includedCount = items?.filter((i) => i.include).length ?? 0

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        title={t('registry:publish.button')}
        aria-label={t('registry:publish.button')}
        onClick={() => void onOpen()}
      >
        <Share2 size={14} />
      </Button>
      <Drawer open={open} onOpenChange={(o) => !o && setOpen(false)}>
        <DrawerContent width={640} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <DrawerTitle>{t('registry:publish.title')}</DrawerTitle>

          {result ? (
            <>
              <div
                className="surface-panel"
                style={{ borderRadius: 12, padding: '12px 14px', display: 'grid', gap: 8, fontSize: '0.875rem', color: 'var(--color-fg-2)' }}
              >
                <p style={{ margin: 0, display: 'flex', gap: 8, alignItems: 'center', color: 'var(--color-fg-1)' }}>
                  <FolderCheck size={16} style={{ color: 'var(--color-brand-500)' }} />
                  {t('registry:publish.doneSummary', { count: result.files.length })}
                </p>
                <p style={{ margin: 0, fontFamily: 'var(--font-mono, monospace)', fontSize: '0.8rem', wordBreak: 'break-all' }}>
                  {result.dir}
                </p>
                {prUrl ? (
                  <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--color-brand-600, var(--color-brand-500))', wordBreak: 'break-all' }}>
                    {t('registry:publish.prDone', { url: prUrl })}
                  </p>
                ) : (
                  <p style={{ margin: 0, fontSize: '0.8rem' }}>{t('registry:publish.doneNext')}</p>
                )}
              </div>
              {errorMsg ? (
                <p role="alert" style={{ margin: 0, fontSize: '0.8rem', color: 'var(--color-danger)' }}>
                  <CircleAlert size={12} style={{ marginRight: 4, verticalAlign: -2 }} />
                  {errorMsg}
                </p>
              ) : null}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 'auto' }}>
                <Button
                  variant="ghost"
                  onClick={() => {
                    window.one.registry.openContribute()
                  }}
                >
                  {t('registry:publish.openContribute')}
                </Button>
                {!prUrl ? (
                  <Button onClick={() => void onSubmitPr()} disabled={prPending}>
                    <GitPullRequest size={14} />
                    {prPending ? t('registry:publish.prWorking') : t('registry:publish.autoPr')}
                  </Button>
                ) : null}
                <Button variant={prUrl ? 'default' : 'secondary'} onClick={() => setOpen(false)}>
                  {t('registry:publish.close')}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="section-subtitle" style={{ margin: 0 }}>
                {t('registry:publish.subtitle')}
              </p>

              {planning ? (
                <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--color-fg-3)' }}>
                  {t('registry:publish.planning')}
                </p>
              ) : null}

              {items ? (
                <div style={{ display: 'grid', gap: 8, overflowY: 'auto', minHeight: 0 }}>
                  {items.map((item, idx) => (
                    <div
                      key={`${item.kind}:${item.localId}`}
                      className="surface-panel"
                      style={{
                        borderRadius: 12,
                        padding: '10px 14px',
                        display: 'grid',
                        gap: 8,
                        opacity: item.include ? 1 : 0.55,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                          type="checkbox"
                          checked={item.include}
                          onChange={(e) => patchItem(idx, { include: e.target.checked })}
                          aria-label={item.name}
                        />
                        <span style={{ fontSize: '0.875rem', color: 'var(--color-fg-1)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {item.name}
                        </span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--color-fg-3)', flexShrink: 0 }}>
                          {t(`registry:kind.${item.kind}`)}
                        </span>
                        <span style={{ flex: 1 }} />
                        {item.auto ? (
                          <Badge style={{ fontSize: '0.7rem' }}>{t('registry:publish.auto')}</Badge>
                        ) : null}
                        <Badge variant={item.status === 'update' ? 'brand' : undefined} style={{ fontSize: '0.7rem' }}>
                          {t(`registry:publish.${item.status}`)}
                        </Badge>
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <Input
                          value={item.slug}
                          disabled={!item.include}
                          onChange={(e) => patchItem(idx, { slug: e.target.value })}
                          placeholder="slug"
                          style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '0.8rem' }}
                        />
                        <Input
                          value={item.version}
                          disabled={!item.include}
                          onChange={(e) => patchItem(idx, { version: e.target.value })}
                          placeholder="1.0.0"
                          style={{ width: 96, flexShrink: 0, fontFamily: 'var(--font-mono, monospace)', fontSize: '0.8rem' }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

              {warnings.length > 0 ? (
                <div
                  role="alert"
                  style={{
                    borderRadius: 12,
                    padding: '10px 14px',
                    border: '1px solid var(--color-danger)',
                    fontSize: '0.8rem',
                    color: 'var(--color-danger)',
                    display: 'grid',
                    gap: 4,
                  }}
                >
                  {warnings.map((w) => (
                    <p key={w} style={{ margin: 0 }}>{w}</p>
                  ))}
                </div>
              ) : null}

              {errorMsg ? (
                <p role="alert" style={{ margin: 0, fontSize: '0.8rem', color: 'var(--color-danger)' }}>
                  <CircleAlert size={12} style={{ marginRight: 4, verticalAlign: -2 }} />
                  {t('registry:publish.failed', { message: errorMsg })}
                </p>
              ) : null}

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 'auto' }}>
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  {t('registry:publish.cancel')}
                </Button>
                <Button onClick={() => void onConfirm()} disabled={applying || planning || !items || includedCount === 0}>
                  {applying ? t('registry:publish.applying') : t('registry:publish.confirm', { count: includedCount })}
                </Button>
              </div>
            </>
          )}
        </DrawerContent>
      </Drawer>
    </>
  )
}
