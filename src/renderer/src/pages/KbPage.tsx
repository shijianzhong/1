import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, BookOpen, Search, Cpu, Zap, Download, RefreshCw, FileUp, Globe } from 'lucide-react'
import { errorMessage } from '@renderer/api/client'
import {
  useKbStatus,
  useKbDocs,
  useKbAdd,
  useKbPickFile,
  useKbRemove,
  useKbSearch,
  useKbReindex,
  useKbDownloadModel,
  useKbSetProviderPreference,
  useKbReindexProgress,
  useKbDownloadModelProgress,
  useProviders,
} from '@renderer/api/hooks'
import { Button } from '@renderer/components/ui/Button'
import { Input } from '@renderer/components/ui/Input'
import { Badge } from '@renderer/components/ui/Badge'
import { confirmDialog } from '@renderer/components/ui/ConfirmDialog'
import { EmptyState } from '@renderer/components/ui/EmptyState'
import { Field } from '@renderer/components/ui/Field'
import { PageToolbar } from '@renderer/components/ui/PageToolbar'
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
} from '@renderer/components/ui/Drawer'
import type {
  KbDownloadModelProgressEvent,
  KbReindexProgressEvent,
  KbSearchHit,
} from '@shared/types'

// —— 知识库管理页（docs/VECTOR_KB_PLAN.md §七 P2）——
// 三个区块：
//   1. embedding 状态条（useKbStatus → ready/missing + 维度 + 分块数）
//   2. 检索预览框（验证 hybrid 闭环：输入查询 → 返回 content 片段 + score + 来源）
//   3. 文档卡片网格（title + chunks + provider + 删除；添加走抽屉 textarea）
// 模型下载按钮 P4 接，此处 disabled 占位。

function formatTime(ts?: number): string {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return ''
  }
}

/** URL → hostname（失败回退原 url 串）；用于 URL 摄取的默认标题 */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export function KbPage() {
  const { t } = useTranslation(['kb', 'common', 'errors'])
  const { data: status, isLoading: statusLoading } = useKbStatus()
  const { data: docsData, isLoading: docsLoading } = useKbDocs()
  const { data: providersData } = useProviders()
  const addMut = useKbAdd()
  const pickFileMut = useKbPickFile()
  const removeMut = useKbRemove()
  const searchMut = useKbSearch()
  const reindexMut = useKbReindex()
  const downloadMut = useKbDownloadModel()
  const setPrefMut = useKbSetProviderPreference()

  const [draft, setDraft] = useState<{
    title: string
    content: string
    url: string
    sourceKind: string
    sourcePath: string
  } | null>(null)

  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<KbSearchHit[]>([])
  const [degraded, setDegraded] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  // reindex 进度（webContents.send 单向流，非 TanStack Query）
  const [reindexProg, setReindexProg] = useState<KbReindexProgressEvent | null>(null)
  const [reindexError, setReindexError] = useState<string | null>(null)
  // 取消不是失败：中性提示（全量重嵌取消后 reindexRequired 标志仍在，剩余待补）
  const [reindexNotice, setReindexNotice] = useState<string | null>(null)
  // provider 切换失败独立错误区（review #17：不写进搜索框错误区）
  const [providerError, setProviderError] = useState<string | null>(null)
  // 摄取失败反馈（review #14：add/pickFile/fetchUrl 的 mutateAsync 此前无 catch 静默失败）
  const [ingestError, setIngestError] = useState<string | null>(null)
  // 删除失败反馈（文档网格区）
  const [docsError, setDocsError] = useState<string | null>(null)
  const onReindexProg = useCallback((ev: KbReindexProgressEvent) => {
    if (ev.type === 'error') {
      setReindexError(ev.message ?? t('kb:reindex.failed', { message: '' }))
      setReindexNotice(null)
    } else if (ev.type === 'cancelled') {
      setReindexProg(null)
      setReindexError(null)
      setReindexNotice(t('kb:reindex.cancelled', { done: ev.done, total: ev.total }))
    } else if (ev.type === 'done') {
      setReindexProg(null)
      setReindexNotice(null)
    } else {
      setReindexProg(ev)
      setReindexError(null)
      setReindexNotice(null)
    }
  }, [t])
  useKbReindexProgress(onReindexProg)

  // 模型下载进度
  const [downloadProg, setDownloadProg] = useState<KbDownloadModelProgressEvent | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const onDownloadProg = useCallback((ev: KbDownloadModelProgressEvent) => {
    if (ev.type === 'error') {
      setDownloadError(ev.message ?? '')
      setDownloadProg(null)
    } else if (ev.type === 'done') {
      setDownloadProg(null)
    } else {
      setDownloadProg(ev)
      setDownloadError(null)
    }
  }, [])
  useKbDownloadModelProgress(onDownloadProg)

  // 远程 embedding provider 候选（models.embedding 已配的）
  const remoteProviders = (providersData ?? []).filter((p) => !!p.models?.embedding)

  const docs = docsData ?? []
  const embeddingReady = status?.embedding === 'ready'
  const embeddingMissing = status?.embedding === 'missing'
  const embeddingConfigError = status?.embedding === 'config-error'

  const onDownloadModel = async (): Promise<void> => {
    setDownloadError(null)
    try {
      await downloadMut.mutateAsync()
    } catch (err) {
      setDownloadError(errorMessage(err, t))
    }
  }

  const onReindex = async (): Promise<void> => {
    setReindexError(null)
    setReindexNotice(null)
    setReindexProg({ type: 'progress', done: 0, total: status?.chunkCount ?? 0 })
    try {
      await reindexMut.mutateAsync()
    } catch (err) {
      setReindexError(errorMessage(err, t))
      setReindexProg(null)
    }
  }

  const onProviderChange = async (providerId: string): Promise<void> => {
    const prefId = providerId === 'local' ? null : providerId
    setProviderError(null)
    try {
      await setPrefMut.mutateAsync({ providerId: prefId })
    } catch (err) {
      setProviderError(errorMessage(err, t))
    }
  }

  const onAdd = async (): Promise<void> => {
    if (!draft?.title.trim() || !draft.content.trim()) return
    setIngestError(null)
    try {
      await addMut.mutateAsync({
        title: draft.title.trim(),
        content: draft.content,
        sourceKind: draft.sourceKind.trim() || undefined,
        sourcePath: draft.sourcePath.trim() || undefined,
      })
      setDraft(null)
    } catch (err) {
      // 失败留抽屉 + 错误反馈（此前 unhandled rejection 静默失败）
      setIngestError(errorMessage(err, t))
    }
  }

  // P5：文件摄取——主进程弹框+抽取+ingest。cancel 返 null → 留开抽屉无报错
  const onPickFile = async (): Promise<void> => {
    setIngestError(null)
    try {
      const r = await pickFileMut.mutateAsync()
      if (r) setDraft(null) // 成功摄取 → 关抽屉；null = cancel → 留开
    } catch (err) {
      setIngestError(errorMessage(err, t))
    }
  }

  // P5：URL 抓取——主进程 Jina Reader → content → ingest
  const onFetchUrl = async (): Promise<void> => {
    if (!draft?.url.trim()) return
    const url = draft.url.trim()
    setIngestError(null)
    try {
      await addMut.mutateAsync({
        title: draft.title.trim() || hostnameOf(url),
        url,
        sourceKind: 'url',
        sourcePath: url,
      })
      setDraft(null)
    } catch (err) {
      setIngestError(errorMessage(err, t))
    }
  }

  const onRemove = async (docId: string): Promise<void> => {
    const ok = await confirmDialog({
      title: t('kb:removeConfirm'),
      confirmText: t('common:actions.delete'),
    })
    if (!ok) return
    setDocsError(null)
    try {
      await removeMut.mutateAsync(docId)
    } catch (err) {
      setDocsError(errorMessage(err, t))
    }
  }

  const onSearch = async (): Promise<void> => {
    const q = query.trim()
    if (!q) return
    setSearchError(null)
    try {
      const res = await searchMut.mutateAsync({ query: q, k: 5 })
      setHits(res.hits)
      setDegraded(res.degraded)
    } catch (err) {
      setSearchError(errorMessage(err, t))
    }
  }

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', display: 'grid', gap: 20 }}>
      <PageToolbar
        title={t('kb:title')}
        subtitle={t('kb:subtitle')}
        actions={
          <Button onClick={() => { setIngestError(null); setDraft({ title: '', content: '', url: '', sourceKind: 'md', sourcePath: '' }) }}>
            <Plus size={16} /> {t('kb:add.title')}
          </Button>
        }
      />

      {/* embedding 状态条 */}
      <section
        className="surface-panel"
        style={{
          borderRadius: 18,
          padding: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          flexWrap: 'wrap',
        }}
      >
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            background: 'var(--color-bg-3)',
            display: 'grid',
            placeItems: 'center',
            flexShrink: 0,
          }}
        >
          <Cpu size={20} style={{ color: embeddingReady ? 'var(--color-brand-500)' : 'var(--color-fg-3)' }} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          {statusLoading ? (
            <p className="section-subtitle" style={{ margin: 0 }}>{t('common:state.loading')}</p>
          ) : (
            <>
              <p className="section-title" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {embeddingReady
                  ? status?.provider === 'remote'
                    ? t('kb:status.remote')
                    : t('kb:status.ready')
                  : embeddingConfigError
                    ? t('kb:status.configError')
                    : t('kb:status.missing')}
                {embeddingReady && status?.dimension != null ? (
                  <Badge variant="brand" style={{ fontSize: '0.7rem' }}>
                    {t('kb:status.dim', { dim: status.dimension })}
                  </Badge>
                ) : null}
                {status?.reindexRequired ? (
                  <Badge variant="warning" style={{ fontSize: '0.7rem' }}>
                    <Zap size={10} style={{ marginRight: 4 }} />
                    {t('kb:status.reindexRequired')}
                  </Badge>
                ) : null}
              </p>
              <p className="section-subtitle" style={{ margin: '4px 0 0' }}>
                {status?.chunkCount != null ? t('kb:status.chunks', { count: status.chunkCount }) : ''}
                {status?.provider && status.provider !== 'none'
                  ? ` · ${t('kb:status.provider', { provider: status.provider })}`
                  : ''}
                {status?.embeddingModel ? ` · ${status.embeddingModel}` : ''}
              </p>
              {!embeddingReady && embeddingMissing ? (
                <p style={{ margin: '6px 0 0', fontSize: '0.78rem', color: 'var(--color-fg-3)' }}>
                  {t('kb:status.modelMissingHint')}
                </p>
              ) : null}
              {providerError ? (
                <p role="alert" style={{ margin: '6px 0 0', fontSize: '0.78rem', color: 'var(--color-danger)' }}>
                  {providerError}
                </p>
              ) : null}
              {reindexError ? (
                <p role="alert" style={{ margin: '6px 0 0', fontSize: '0.78rem', color: 'var(--color-danger)' }}>
                  {t('kb:reindex.failed', { message: reindexError })}
                </p>
              ) : null}
              {reindexNotice ? (
                <p style={{ margin: '6px 0 0', fontSize: '0.78rem', color: 'var(--color-fg-3)' }}>
                  {reindexNotice}
                </p>
              ) : null}
              {downloadError ? (
                <p role="alert" style={{ margin: '6px 0 0', fontSize: '0.78rem', color: 'var(--color-danger)' }}>
                  {t('kb:download.failed', { message: downloadError })}
                </p>
              ) : null}
            </>
          )}
        </div>

        {/* 右侧动作区 */}
        {!statusLoading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {/* provider 下拉（本地 + 远程候选） */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', color: 'var(--color-fg-2)' }}>
              {t('kb:provider.label')}
              <select
                value={status?.activeProviderId ?? 'local'}
                onChange={(e) => void onProviderChange(e.target.value)}
                disabled={setPrefMut.isPending}
                style={selectStyle}
              >
                <option value="local">{t('kb:provider.local')}</option>
                {remoteProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.models?.embedding}
                  </option>
                ))}
              </select>
            </label>

            {/* 模型下载（仅 local missing 时） */}
            {embeddingMissing ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void onDownloadModel()}
                disabled={downloadMut.isPending}
              >
                <Download size={14} />
                {downloadMut.isPending || downloadProg ? t('kb:download.downloading') : t('kb:download.button')}
              </Button>
            ) : null}

            {/* 重嵌按钮（reindexRequired 或有 NULL 块时） */}
            {(status?.reindexRequired || embeddingConfigError === false) && (embeddingReady || status?.reindexRequired) ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void onReindex()}
                disabled={reindexMut.isPending || !embeddingReady}
              >
                <RefreshCw size={14} />
                {reindexMut.isPending ? t('kb:reindex.running', { done: reindexProg?.done ?? 0, total: reindexProg?.total ?? 0 }) : t('kb:reindex.button')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* reindex / download 进度条 */}
      {reindexProg && reindexProg.total > 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <progress
            value={reindexProg.done}
            max={reindexProg.total}
            style={{ flex: 1, height: 6 }}
          />
          <span style={{ fontSize: '0.72rem', color: 'var(--color-fg-3)' }}>
            {reindexProg.done}/{reindexProg.total}
          </span>
        </div>
      ) : null}
      {downloadProg && downloadProg.total > 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <progress
            value={downloadProg.done}
            max={downloadProg.total}
            style={{ flex: 1, height: 6 }}
          />
          <span style={{ fontSize: '0.72rem', color: 'var(--color-fg-3)' }}>
            {downloadProg.file} {downloadProg.done}/{downloadProg.total}
          </span>
        </div>
      ) : null}

      {/* 检索预览框 */}
      <section
        className="surface-panel"
        style={{ borderRadius: 18, padding: 16, display: 'grid', gap: 12 }}
      >
        <h3 className="section-title" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Search size={16} /> {t('kb:search.title')}
        </h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onSearch()
            }}
            placeholder={t('kb:search.placeholder')}
            style={{ flex: 1 }}
          />
          <Button onClick={() => void onSearch()} disabled={searchMut.isPending || !query.trim()}>
            {searchMut.isPending ? t('kb:search.searching') : t('kb:search.button')}
          </Button>
        </div>
        {searchError ? (
          <p role="alert" style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-danger)' }}>
            {searchError}
          </p>
        ) : null}
        {degraded ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Badge variant="warning" style={{ fontSize: '0.7rem' }}>
              <Zap size={10} style={{ marginRight: 4 }} />
              {t('kb:search.degraded')}
            </Badge>
            <span style={{ fontSize: '0.75rem', color: 'var(--color-fg-3)' }}>{t('kb:search.degradedHint')}</span>
          </div>
        ) : null}
        {hits.length === 0 && !searchMut.isPending ? (
          <p className="section-subtitle" style={{ margin: 0 }}>
            {query.trim() ? t('kb:search.noResults') : t('kb:search.empty')}
          </p>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {hits.map((h) => (
              <article
                key={h.chunkId}
                style={{
                  borderRadius: 12,
                  border: '1px solid var(--color-border)',
                  background: 'var(--color-bg-1)',
                  padding: 12,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                  <span className="section-title" style={{ margin: 0, fontSize: '0.9rem' }}>{h.title}</span>
                  {h.sectionTitle ? (
                    <Badge variant="default" style={{ fontSize: '0.65rem' }}>
                      {t('kb:search.section', { section: h.sectionTitle })}
                    </Badge>
                  ) : null}
                  {h.source ? (
                    <span style={{ fontSize: '0.7rem', color: 'var(--color-fg-3)' }}>
                      {t('kb:search.source', { source: h.source })}
                    </span>
                  ) : null}
                  <span style={{ marginLeft: 'auto', fontSize: '0.7rem', color: 'var(--color-fg-3)' }}>
                    {t('kb:search.score', { score: h.score.toFixed(4) })}
                  </span>
                </div>
                <pre
                  style={{
                    margin: 0,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontSize: '0.8rem',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--color-fg-2)',
                    maxHeight: 200,
                    overflow: 'hidden',
                  }}
                >
                  {h.content}
                </pre>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* 文档操作错误（删除失败等） */}
      {docsError ? (
        <p role="alert" style={{ margin: 0, fontSize: '0.78rem', color: 'var(--color-danger)' }}>
          {docsError}
        </p>
      ) : null}

      {/* 文档卡片网格 */}
      {docsLoading ? (
        <EmptyState text={t('common:state.loading')} />
      ) : docs.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title={t('kb:empty')}
          onClick={() => { setIngestError(null); setDraft({ title: '', content: '', url: '', sourceKind: 'md', sourcePath: '' }) }}
          actionLabel={t('kb:add.title')}
        />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 16,
          }}
        >
          {docs.map((d) => (
            <article
              key={d.id}
              className="surface-panel asset-card"
              style={{ borderRadius: 18, padding: 18 }}
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
                  <BookOpen size={18} style={{ color: 'var(--color-brand-500)' }} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <h3 className="section-title">{d.title}</h3>
                  {d.sourcePath ? (
                    <p
                      className="section-subtitle"
                      style={{
                        marginTop: 2,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {d.sourcePath}
                    </p>
                  ) : null}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                <Badge variant="default" style={{ fontSize: '0.7rem' }}>
                  {d.chunks ? t('kb:doc.chunks', { count: d.chunks }) : t('kb:doc.noChunks')}
                </Badge>
                {d.embeddingProvider ? (
                  <Badge variant="brand" style={{ fontSize: '0.7rem' }}>
                    {t('kb:doc.provider', { provider: d.embeddingProvider })}
                  </Badge>
                ) : (
                  <Badge variant="default" style={{ fontSize: '0.7rem' }}>
                    {t('kb:doc.noProvider')}
                  </Badge>
                )}
                {d.sourceKind ? (
                  <Badge variant="default" style={{ fontSize: '0.7rem' }}>{d.sourceKind}</Badge>
                ) : null}
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  gap: 4,
                  marginTop: 14,
                  paddingTop: 10,
                  borderTop: '1px solid var(--color-border)',
                }}
              >
                {d.updatedAt ? (
                  <span style={{ marginRight: 'auto', fontSize: '0.7rem', color: 'var(--color-fg-3)' }}>
                    {t('kb:doc.updatedAt', { time: formatTime(d.updatedAt) })}
                  </span>
                ) : null}
                <Button variant="ghost" size="icon" onClick={() => void onRemove(d.id)}>
                  <Trash2 size={14} />
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}

      {/* 添加文档抽屉 */}
      <Drawer open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <DrawerContent width={720}>
          {draft ? (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
              <DrawerTitle>{t('kb:add.title')}</DrawerTitle>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 20, flex: 1, minHeight: 0 }}>
                <Field label={t('kb:add.titleField')}>
                  <Input
                    value={draft.title}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    placeholder={t('kb:add.titlePh')}
                    autoFocus
                  />
                </Field>
                {/* P5：文件 + URL 摄取入口（content-XOR-url；文件走主进程 dialog） */}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Button
                    variant="ghost"
                    onClick={() => void onPickFile()}
                    disabled={pickFileMut.isPending}
                  >
                    <FileUp size={15} style={{ marginRight: 6 }} />
                    {pickFileMut.isPending ? t('kb:add.pickFilePending') : t('kb:add.pickFile')}
                  </Button>
                  <span style={{ fontSize: '0.75rem', color: 'var(--color-fg-muted)' }}>
                    {t('kb:add.pickFileHint')}
                  </span>
                </div>
                <Field label={t('kb:add.urlField')}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Input
                      value={draft.url}
                      onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                      placeholder={t('kb:add.urlPh')}
                    />
                    <Button
                      variant="ghost"
                      onClick={() => void onFetchUrl()}
                      disabled={!draft.url.trim() || addMut.isPending}
                    >
                      <Globe size={15} style={{ marginRight: 6 }} />
                      {t('kb:add.fetchUrl')}
                    </Button>
                  </div>
                </Field>
                <Field label={t('kb:add.sourceKind')}>
                  <select
                    value={draft.sourceKind}
                    onChange={(e) => setDraft({ ...draft, sourceKind: e.target.value })}
                    style={selectStyle}
                  >
                    <option value="md">md</option>
                    <option value="txt">txt</option>
                    <option value="pdf">pdf</option>
                    <option value="docx">docx</option>
                    <option value="url">url</option>
                  </select>
                </Field>
                <Field label={t('kb:add.sourcePath')}>
                  <Input
                    value={draft.sourcePath}
                    onChange={(e) => setDraft({ ...draft, sourcePath: e.target.value })}
                    placeholder={t('kb:add.sourcePathPh')}
                  />
                </Field>
                <Field label={t('kb:add.contentField')} style={{ flex: '1', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                  <textarea
                    value={draft.content}
                    onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                    style={{ ...contentStyle, flex: 1, minHeight: 0 }}
                    placeholder={t('kb:add.contentPh')}
                  />
                </Field>
                {ingestError ? (
                  <p role="alert" style={{ margin: 0, fontSize: '0.78rem', color: 'var(--color-danger)', flexShrink: 0 }}>
                    {ingestError}
                  </p>
                ) : null}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexShrink: 0 }}>
                  <Button variant="ghost" onClick={() => setDraft(null)}>
                    {t('common:actions.cancel')}
                  </Button>
                  <Button
                    onClick={() => void onAdd()}
                    disabled={!draft.title.trim() || !draft.content.trim() || addMut.isPending}
                  >
                    {addMut.isPending ? t('kb:add.submitting') : t('kb:add.submit')}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </DrawerContent>
      </Drawer>
    </div>
  )
}

const contentStyle: React.CSSProperties = {
  minHeight: 200,
  borderRadius: 12,
  border: '1px solid var(--color-border)',
  background: 'var(--color-bg-1)',
  color: 'var(--color-fg-1)',
  padding: 10,
  fontFamily: 'var(--font-mono)',
  fontSize: '0.875rem',
  resize: 'none',
  width: '100%',
}

const selectStyle: React.CSSProperties = {
  borderRadius: 8,
  border: '1px solid var(--color-border)',
  background: 'var(--color-bg-1)',
  color: 'var(--color-fg-1)',
  padding: '4px 8px',
  fontSize: '0.78rem',
  outline: 'none',
}
