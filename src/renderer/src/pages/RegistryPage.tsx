import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  ArrowUpCircle,
  Bot,
  Boxes,
  CircleAlert,
  Download,
  FileCode2,
  RefreshCw,
  Search,
  Star,
  Wrench,
} from 'lucide-react'
import { useAgents, useApplyRegistryImport, useCapabilities, usePlanRegistryImport, useRefreshRegistryIndex, useRegistryIndex, useRegistryManifest, useRegistryRepoStats, useSkills } from '@renderer/api/hooks'
import { errorMessage, IpcError } from '@renderer/api/client'
import { Badge } from '@renderer/components/ui/Badge'
import { Button } from '@renderer/components/ui/Button'
import { Input } from '@renderer/components/ui/Input'
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
} from '@renderer/components/ui/Drawer'
import { EmptyState } from '@renderer/components/ui/EmptyState'
import type {
  Agent,
  Capability,
  RegistryAgentManifest,
  RegistryAssetKind,
  RegistryCapabilityManifest,
  RegistryImportPlan,
  RegistryImportResult,
  RegistryIndexEntry,
  SkillMeta,
} from '@shared/types'

// —— Registry 浏览/导入页（docs/REGISTRY_PLAN.md §3.1/§3.2）——
// 列表：index.json 三类条目 + 类型过滤 + 名称/标签搜索；
// 状态：provenance.registryId 比对出 已安装/有更新；
// 导入：planImport（依赖树 + 脚本清单）→ 确认 → applyImport，capability 可选仅导入图。

type Filter = 'all' | RegistryAssetKind

const KIND_ICON: Record<RegistryAssetKind, typeof Bot> = {
  agent: Bot,
  skill: Wrench,
  capability: Boxes,
}

interface Selected {
  kind: RegistryAssetKind
  entry: RegistryIndexEntry
}

function errMsg(e: unknown, t?: (key: string, opts?: { defaultValue?: string }) => string): string {
  return errorMessage(e, t)
}

/** 检查错误是否为 registry 限流（兼容 messageKey 和原始 message 两种路径） */
function isRateLimited(e: unknown): boolean {
  if (e instanceof IpcError) {
    const key = e.messageKey ?? ''
    return (
      key === 'errors:registry.pr_rate_limited' ||
      key === 'errors.registry.pr_rate_limited' ||
      e.message.includes('registry_rate_limited')
    )
  }
  return e instanceof Error ? e.message.includes('registry_rate_limited') : String(e).includes('registry_rate_limited')
}

export function RegistryPage() {
  const { t } = useTranslation(['registry', 'common'])
  const nav = useNavigate()
  const indexQ = useRegistryIndex()
  const agentsQ = useAgents()
  const skillsQ = useSkills()
  const capsQ = useCapabilities()
  const refresh = useRefreshRegistryIndex()
  const planImport = usePlanRegistryImport()
  const applyImport = useApplyRegistryImport()
  const statsQ = useRegistryRepoStats()

  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Selected | null>(null)
  const [plan, setPlan] = useState<RegistryImportPlan | null>(null)
  const [materialize, setMaterialize] = useState(true)
  const [resultMsg, setResultMsg] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [quickMsg, setQuickMsg] = useState<string | null>(null)
  const [quickBusy, setQuickBusy] = useState<string | null>(null)

  const manifestQ = useRegistryManifest(selected?.kind, selected?.entry.id)

  /** provenance 比对：未安装 / 已安装 / 有更新（远端 version 缺失时不判更新） */
  const localStatus = (kind: RegistryAssetKind, slug: string, remoteVersion?: string) => {
    const list: Array<Agent | SkillMeta | Capability> =
      kind === 'agent' ? agentsQ.data ?? [] : kind === 'skill' ? skillsQ.data ?? [] : capsQ.data ?? []
    const local = list.find((x) => x.registry?.registryId === slug)
    if (!local) return 'new' as const
    return remoteVersion && local.registry!.version !== remoteVersion ? ('update' as const) : ('installed' as const)
  }

  const entries = useMemo(() => {
    const index = indexQ.data?.index
    if (!index) return []
    const all: Selected[] = [
      ...index.agents.map((entry) => ({ kind: 'agent' as const, entry })),
      ...index.skills.map((entry) => ({ kind: 'skill' as const, entry })),
      ...index.capabilities.map((entry) => ({ kind: 'capability' as const, entry })),
    ]
    const q = query.trim().toLowerCase()
    return all.filter(({ kind, entry }) => {
      if (filter !== 'all' && kind !== filter) return false
      if (!q) return true
      return (
        entry.name.toLowerCase().includes(q) ||
        (entry.description ?? '').toLowerCase().includes(q) ||
        (entry.tags ?? []).some((tag) => tag.toLowerCase().includes(q))
      )
    })
  }, [indexQ.data, filter, query])

  const openDetail = (sel: Selected): void => {
    setSelected(sel)
    setPlan(null)
    setResultMsg(null)
    setErrorMsg(null)
    setMaterialize(true)
  }

  const onPlan = async (): Promise<void> => {
    if (!selected) return
    setErrorMsg(null)
    setResultMsg(null)
    try {
      setPlan(await planImport.mutateAsync({ kind: selected.kind, id: selected.entry.id }))
    } catch (e) {
      setErrorMsg(t('registry:result.failed', { message: errMsg(e, t) }))
    }
  }

  /** 导入结果 → 一句话摘要（详情抽屉与一键更新共用） */
  const resultSummary = (r: RegistryImportResult): string => {
    const parts: string[] = []
    if (r.imported.length > 0) {
      parts.push(t('registry:result.imported', { names: r.imported.map((i) => i.name).join(', ') }))
    }
    const skippedInstalled = r.skipped.filter((i) => i.reason !== 'locally_modified')
    const skippedModified = r.skipped.filter((i) => i.reason === 'locally_modified')
    if (skippedInstalled.length > 0) {
      parts.push(t('registry:result.skipped', { names: skippedInstalled.map((i) => i.name).join(', ') }))
    }
    if (skippedModified.length > 0) {
      parts.push(
        t('registry:result.skippedModified', { names: skippedModified.map((i) => i.name).join(', ') }),
      )
    }
    if (r.droppedSkillSlugs && r.droppedSkillSlugs.length > 0) {
      parts.push(t('registry:result.dropped', { slugs: r.droppedSkillSlugs.join(', ') }))
    }
    return parts.join(' / ') || t('registry:result.success')
  }

  const onApply = async (): Promise<void> => {
    if (!selected) return
    setErrorMsg(null)
    try {
      const r = await applyImport.mutateAsync({
        kind: selected.kind,
        id: selected.entry.id,
        materializeAgents: materialize,
      })
      setPlan(null)
      setResultMsg(resultSummary(r))
    } catch (e) {
      setErrorMsg(t('registry:result.failed', { message: errMsg(e, t) }))
    }
  }

  /** 一键更新（§Phase 5）：plan 无脚本直接 apply；含脚本回落到详情抽屉让用户确认 */
  const onQuickUpdate = async (kind: RegistryAssetKind, entry: RegistryIndexEntry): Promise<void> => {
    const key = `${kind}:${entry.id}`
    setQuickBusy(key)
    setQuickMsg(null)
    try {
      const p = await planImport.mutateAsync({ kind, id: entry.id })
      if (p.hasScripts) {
        openDetail({ kind, entry })
        setPlan(p)
        return
      }
      const r = await applyImport.mutateAsync({ kind, id: entry.id })
      setQuickMsg(resultSummary(r))
    } catch (e) {
      setQuickMsg(t('registry:result.failed', { message: errMsg(e, t) }))
    } finally {
      setQuickBusy(null)
    }
  }

  const planAllInstalled = plan !== null && plan.items.every((i) => i.status === 'installed')

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', display: 'grid', gap: 20 }}>
      {/* 顶部工具条 */}
      <section
        className="glass-panel"
        style={{
          padding: 16,
          borderRadius: 20,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h2 className="section-title" style={{ fontSize: '1rem' }}>
            {t('registry:title')}
          </h2>
          <p className="section-subtitle">{t('registry:subtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ position: 'relative' }}>
            <Search
              size={14}
              style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-fg-3)' }}
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('registry:searchPh')}
              style={{ paddingLeft: 30, width: 220 }}
            />
          </div>
          {statsQ.data ? (
            <Badge style={{ fontSize: '0.75rem', gap: 4 }} title="GitHub stars">
              <Star size={11} style={{ color: 'var(--color-brand-500)' }} />
              {statsQ.data.stars}
            </Badge>
          ) : null}
          <Button
            variant="outline"
            onClick={() => void refresh.mutateAsync()}
            disabled={refresh.isPending}
          >
            <RefreshCw size={16} /> {t('registry:refresh')}
          </Button>
        </div>
      </section>

      {/* 类型过滤 */}
      <div style={{ display: 'flex', gap: 8 }}>
        {(['all', 'agent', 'skill', 'capability'] as const).map((f) => (
          <Button
            key={f}
            variant={filter === f ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilter(f)}
          >
            {t(`registry:filter.${f}`)}
          </Button>
        ))}
      </div>

      {/* 缓存回退提示 */}
      {indexQ.data?.stale ? (
        <p
          className="glass-panel"
          role="status"
          style={{ margin: 0, padding: '10px 16px', borderRadius: 14, fontSize: '0.8rem', color: 'var(--color-fg-2)' }}
        >
          {t('registry:stale')}
        </p>
      ) : null}

      {/* 限流引导条（§4.3：403 → 引导配置 Token 提升限额） */}
      {indexQ.isError && isRateLimited(indexQ.error) ? (
        <div
          role="alert"
          className="glass-panel"
          style={{
            margin: 0,
            padding: '10px 16px',
            borderRadius: 14,
            fontSize: '0.8rem',
            color: 'var(--color-fg-1)',
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            border: '1px solid var(--color-danger)',
          }}
        >
          <span style={{ flex: 1 }}>{t('registry:rateLimit.title')}</span>
          <Button size="sm" onClick={() => nav('/settings')}>
            {t('registry:rateLimit.action')}
          </Button>
        </div>
      ) : null}

      {/* 一键更新结果反馈 */}
      {quickMsg ? (
        <p role="status" style={{ margin: 0, fontSize: '0.8rem', color: 'var(--color-fg-2)' }}>
          {quickMsg}
        </p>
      ) : null}

      {/* 条目网格 */}
      {indexQ.isLoading ? (
        <EmptyState text={t('common:state.loading')} />
      ) : indexQ.isError ? (
        <EmptyState
          text={t('registry:errors.loadFailed', { message: errMsg(indexQ.error, t) })}
          danger
        />
      ) : entries.length === 0 ? (
        <EmptyState text={t('registry:empty')} />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 16,
          }}
        >
          {entries.map(({ kind, entry }) => {
            const Icon = KIND_ICON[kind]
            const status = localStatus(kind, entry.id, entry.version)
            return (
              <article
                key={`${kind}:${entry.id}`}
                className="surface-panel asset-card"
                style={{ borderRadius: 18, padding: 18, cursor: 'pointer' }}
                onClick={() => openDetail({ kind, entry })}
              >
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', minWidth: 0 }}>
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 10,
                      background: 'var(--color-bg-3)',
                      display: 'grid',
                      placeItems: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <Icon size={18} style={{ color: 'var(--color-brand-500)' }} />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <h3 className="section-title">{entry.name}</h3>
                    {entry.description ? (
                      <p
                        className="section-subtitle"
                        style={{
                          marginTop: 2,
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {entry.description}
                      </p>
                    ) : null}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <Badge style={{ fontSize: '0.7rem' }}>{t(`registry:kind.${kind}`)}</Badge>
                  {status === 'installed' ? (
                    <Badge variant="brand" style={{ fontSize: '0.7rem' }}>
                      {t('registry:badges.installed')}
                    </Badge>
                  ) : status === 'update' ? (
                    <>
                      <Badge variant="brand" style={{ fontSize: '0.7rem' }}>
                        {t('registry:badges.update')}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="icon"
                        style={{ height: 28, width: 28 }}
                        title={t('registry:badges.quickUpdate')}
                        aria-label={t('registry:badges.quickUpdate')}
                        disabled={quickBusy === `${kind}:${entry.id}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          void onQuickUpdate(kind, entry)
                        }}
                      >
                        <ArrowUpCircle size={16} style={{ color: 'var(--color-brand-500)' }} />
                      </Button>
                    </>
                  ) : null}
                  {entry.hasScripts ? (
                    <Badge style={{ fontSize: '0.7rem' }}>
                      <FileCode2 size={10} style={{ marginRight: 4 }} />
                      {t('registry:badges.scripts')}
                    </Badge>
                  ) : null}
                  {entry.hasDiscipline ? (
                    <Badge style={{ fontSize: '0.7rem' }}>{t('registry:badges.discipline')}</Badge>
                  ) : null}
                </div>
                <p style={{ margin: '10px 0 0', fontSize: '0.75rem', color: 'var(--color-fg-3)' }}>
                  {entry.author ? t('registry:card.by', { author: entry.author }) : entry.id}
                  {entry.version ? ` · v${entry.version}` : ''}
                </p>
              </article>
            )
          })}
        </div>
      )}

      {/* 详情 / 导入确认抽屉 */}
      <Drawer open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DrawerContent width={640}>
          {selected ? (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 14 }}>
              <DrawerTitle>{selected.entry.name}</DrawerTitle>

              {plan ? (
                <PlanView
                  plan={plan}
                  kind={selected.kind}
                  materialize={materialize}
                  setMaterialize={setMaterialize}
                  allInstalled={planAllInstalled}
                  applying={applyImport.isPending}
                  onApply={() => void onApply()}
                  onCancel={() => setPlan(null)}
                />
              ) : (
                <DetailView
                  selected={selected}
                  manifest={manifestQ.data}
                  manifestLoading={manifestQ.isLoading}
                  status={localStatus(selected.kind, selected.entry.id, selected.entry.version)}
                  resultMsg={resultMsg}
                  errorMsg={errorMsg}
                  planning={planImport.isPending}
                  onPlan={() => void onPlan()}
                />
              )}
            </div>
          ) : null}
        </DrawerContent>
      </Drawer>
    </div>
  )
}

// —— 详情视图 ——

function DetailView(props: {
  selected: Selected
  manifest: unknown
  manifestLoading: boolean
  status: 'new' | 'installed' | 'update'
  resultMsg: string | null
  errorMsg: string | null
  planning: boolean
  onPlan: () => void
}) {
  const { t } = useTranslation(['registry', 'common'])
  const { selected, manifest } = props
  const { entry } = selected
  // 按 kind 收窄，避免交叉类型断言在未来字段名冲突时踩坑
  const agentM = selected.kind === 'agent' ? (manifest as RegistryAgentManifest | undefined) : undefined
  const capM = selected.kind === 'capability' ? (manifest as RegistryCapabilityManifest | undefined) : undefined

  return (
    <>
      <div style={{ display: 'grid', gap: 10, fontSize: '0.875rem', color: 'var(--color-fg-2)' }}>
        {entry.description ? <p style={{ margin: 0 }}>{entry.description}</p> : null}
        <MetaRow label={t('registry:detail.version')} value={entry.version ? `v${entry.version}` : '—'} />
        {entry.author ? <MetaRow label={t('registry:detail.author')} value={entry.author} /> : null}
        {entry.updatedAt ? <MetaRow label={t('registry:detail.updatedAt')} value={entry.updatedAt} /> : null}
        {entry.tags && entry.tags.length > 0 ? (
          <MetaRow label={t('registry:detail.tags')} value={entry.tags.join(', ')} />
        ) : null}
        {props.manifestLoading ? (
          <p style={{ margin: 0, color: 'var(--color-fg-3)' }}>{t('common:state.loading')}</p>
        ) : (
          <>
            {agentM?.modelHint ? (
              <MetaRow label={t('registry:detail.modelHint')} value={agentM.modelHint} />
            ) : null}
            {agentM?.skillIds && agentM.skillIds.length > 0 ? (
              <MetaRow label={t('registry:detail.depSkills')} value={agentM.skillIds.join(', ')} />
            ) : null}
            {capM?.dependencies ? (
              <>
                {capM.dependencies.agents && capM.dependencies.agents.length > 0 ? (
                  <MetaRow label={t('registry:detail.depAgents')} value={capM.dependencies.agents.join(', ')} />
                ) : null}
                {capM.dependencies.skills && capM.dependencies.skills.length > 0 ? (
                  <MetaRow label={t('registry:detail.depSkills')} value={capM.dependencies.skills.join(', ')} />
                ) : null}
              </>
            ) : null}
          </>
        )}
      </div>

      {props.resultMsg ? (
        <p role="status" style={{ margin: 0, fontSize: '0.8rem', color: 'var(--color-brand-600, var(--color-brand-500))' }}>
          {props.resultMsg}
        </p>
      ) : null}
      {props.errorMsg ? (
        <p role="alert" style={{ margin: 0, fontSize: '0.8rem', color: 'var(--color-danger)' }}>
          <CircleAlert size={12} style={{ marginRight: 4, verticalAlign: -2 }} />
          {props.errorMsg}
        </p>
      ) : null}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 'auto' }}>
        <Button onClick={props.onPlan} disabled={props.planning}>
          <Download size={16} />
          {props.planning
            ? t('registry:detail.planning')
            : props.status === 'installed'
              ? t('registry:detail.import')
              : props.status === 'update'
                ? t('registry:detail.importUpdate')
                : t('registry:detail.import')}
        </Button>
      </div>
    </>
  )
}

// —— 导入计划确认视图 ——

function PlanView(props: {
  plan: RegistryImportPlan
  kind: RegistryAssetKind
  materialize: boolean
  setMaterialize: (v: boolean) => void
  allInstalled: boolean
  applying: boolean
  onApply: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation(['registry', 'common'])
  const { plan } = props
  const scriptItems = plan.items.filter((i) => (i.scripts?.length ?? 0) > 0)

  return (
    <>
      <p className="section-subtitle" style={{ margin: 0 }}>
        {t('registry:plan.title')}
      </p>
      <div style={{ display: 'grid', gap: 8, overflowY: 'auto', minHeight: 0 }}>
        {plan.items.map((item) => (
          <div
            key={`${item.kind}:${item.slug}`}
            className="surface-panel"
            style={{ borderRadius: 12, padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}
          >
            <div style={{ minWidth: 0 }}>
              <span style={{ fontSize: '0.875rem', color: 'var(--color-fg-1)' }}>{item.name}</span>
              <span style={{ fontSize: '0.75rem', color: 'var(--color-fg-3)', marginLeft: 8 }}>
                {t(`registry:kind.${item.kind}`)} · {item.slug}
              </span>
            </div>
            <Badge variant={item.status === 'installed' ? undefined : 'brand'} style={{ fontSize: '0.7rem', flexShrink: 0 }}>
              {t(`registry:plan.${item.status}`)}
            </Badge>
          </div>
        ))}
      </div>

      {scriptItems.length > 0 ? (
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
          <p style={{ margin: 0 }}>{t('registry:plan.scriptsWarning')}</p>
          {scriptItems.map((item) => (
            <p key={item.slug} style={{ margin: 0, fontFamily: 'var(--font-mono)' }}>
              {item.name}: {(item.scripts ?? []).join(', ')}
            </p>
          ))}
        </div>
      ) : null}

      {props.kind === 'capability' && plan.items.some((i) => i.kind === 'agent') ? (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.8rem', color: 'var(--color-fg-2)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={props.materialize}
            onChange={(e) => props.setMaterialize(e.target.checked)}
          />
          {t('registry:plan.materialize')}
        </label>
      ) : null}

      {props.allInstalled ? (
        <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--color-fg-2)' }}>
          {t('registry:plan.allInstalled')}
        </p>
      ) : null}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 'auto' }}>
        <Button variant="ghost" onClick={props.onCancel}>
          {t('registry:plan.cancel')}
        </Button>
        <Button onClick={props.onApply} disabled={props.applying || props.allInstalled}>
          {props.applying ? t('registry:plan.applying') : t('registry:plan.confirm')}
        </Button>
      </div>
    </>
  )
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <p style={{ margin: 0, display: 'flex', gap: 8 }}>
      <span style={{ color: 'var(--color-fg-3)', flexShrink: 0 }}>{label}</span>
      <span style={{ color: 'var(--color-fg-1)', wordBreak: 'break-all' }}>{value}</span>
    </p>
  )
}
