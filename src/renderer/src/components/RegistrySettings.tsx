import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, KeyRound, Plus, RotateCcw, Trash2 } from 'lucide-react'
import type { RegistrySource } from '@shared/types'
import { DEFAULT_REGISTRY_SOURCES, REGISTRY_TOKEN_KEY_ID } from '@shared/types'
import { unwrap } from '@renderer/api/client'
import { useRegistryConfig, useSaveRegistryConfig } from '@renderer/api/hooks'
import { Badge } from '@renderer/components/ui/Badge'
import { Button } from '@renderer/components/ui/Button'
import { Input } from '@renderer/components/ui/Input'

// —— 设置页 Registry 区（docs/REGISTRY_PLAN.md §4.3/§4.4，Phase 4）——
// Token 存 vault（明文不回显，仅 hasKey 状态）；源列表优先级排序 + 自定义追加 +
// repo/ref 配置；保存走主进程校验（非法模板/空源会被打回）。

export function RegistrySettings() {
  const { t } = useTranslation(['settings', 'common'])
  const configQ = useRegistryConfig()
  const saveConfig = useSaveRegistryConfig()

  const [hasToken, setHasToken] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [tokenMsg, setTokenMsg] = useState<string | null>(null)
  const [repo, setRepo] = useState('')
  const [ref, setRef] = useState('')
  const [sources, setSources] = useState<RegistrySource[]>([])
  const [newId, setNewId] = useState('')
  const [newTpl, setNewTpl] = useState('')
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [saveErr, setSaveErr] = useState<string | null>(null)

  const refreshTokenStatus = (): void => {
    window.one.secrets
      .getLLMConfig(REGISTRY_TOKEN_KEY_ID)
      .then(unwrap)
      .then((r) => setHasToken(r.hasKey))
      .catch(() => {})
  }
  useEffect(refreshTokenStatus, [])

  useEffect(() => {
    if (configQ.data) {
      setRepo(configQ.data.repo)
      setRef(configQ.data.ref)
      setSources(configQ.data.sources.map((s) => ({ ...s })))
    }
  }, [configQ.data])

  const onSaveToken = async (): Promise<void> => {
    const apiKey = tokenInput.trim()
    if (!apiKey) return
    try {
      await window.one.secrets.setLLMConfig({ keyId: REGISTRY_TOKEN_KEY_ID, apiKey }).then(unwrap)
      setTokenInput('')
      setTokenMsg(t('settings:registry.tokenSaved'))
      refreshTokenStatus()
    } catch (error) {
      setTokenMsg(error instanceof Error ? error.message : String(error))
    }
  }

  const onRemoveToken = async (): Promise<void> => {
    await window.one.secrets.removeKey(REGISTRY_TOKEN_KEY_ID).then(unwrap).catch(() => {})
    setTokenMsg(null)
    refreshTokenStatus()
  }

  const move = (idx: number, dir: -1 | 1): void => {
    setSources((prev) => {
      const next = [...prev]
      const target = idx + dir
      if (target < 0 || target >= next.length) return prev
      ;[next[idx], next[target]] = [next[target], next[idx]]
      return next
    })
  }

  const addSource = (): void => {
    const id = newId.trim()
    const urlTemplate = newTpl.trim()
    if (!id || !urlTemplate) return
    setSources((prev) => [...prev, { id, urlTemplate }])
    setNewId('')
    setNewTpl('')
  }

  const onSave = async (): Promise<void> => {
    setSaveMsg(null)
    setSaveErr(null)
    try {
      await saveConfig.mutateAsync({ repo: repo.trim(), ref: ref.trim(), sources })
      setSaveMsg(t('settings:registry.saved'))
    } catch (error) {
      setSaveErr(
        t('settings:registry.saveFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }

  return (
    <>
      {/* Token（§4.3 权限分场景引导） */}
      <div style={{ display: 'grid', gap: 8 }}>
        <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--color-fg-1)', display: 'flex', gap: 8, alignItems: 'center' }}>
          <KeyRound size={14} style={{ color: 'var(--color-brand-500)' }} />
          {t('settings:registry.tokenTitle')}
          <Badge variant={hasToken ? 'brand' : undefined} style={{ fontSize: '0.7rem' }}>
            {hasToken ? t('settings:registry.tokenSet') : t('settings:registry.tokenUnset')}
          </Badge>
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <Input
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder={t('settings:registry.tokenPh')}
          />
          <Button size="sm" onClick={() => void onSaveToken()} disabled={!tokenInput.trim()}>
            {t('settings:registry.tokenSave')}
          </Button>
          {hasToken ? (
            <Button variant="ghost" size="sm" onClick={() => void onRemoveToken()}>
              {t('settings:registry.tokenRemove')}
            </Button>
          ) : null}
        </div>
        {tokenMsg ? (
          <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--color-fg-2)' }}>{tokenMsg}</p>
        ) : null}
        <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--color-fg-3)' }}>
          {t('settings:registry.tokenHintRead')}
        </p>
        <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--color-fg-3)' }}>
          {t('settings:registry.tokenHintWrite')}
        </p>
      </div>

      {/* repo / ref */}
      <div style={{ display: 'grid', gap: 8 }}>
        <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--color-fg-1)' }}>
          {t('settings:registry.repoTitle')}
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--color-fg-3)', width: 130, flexShrink: 0 }}>
            {t('settings:registry.repoLabel')}
          </span>
          <Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--color-fg-3)', width: 130, flexShrink: 0 }}>
            {t('settings:registry.refLabel')}
          </span>
          <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="main" />
        </div>
      </div>

      {/* 源列表 */}
      <div style={{ display: 'grid', gap: 8 }}>
        <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--color-fg-1)' }}>
          {t('settings:registry.sourcesTitle')}
        </p>
        {sources.map((s, idx) => (
          <div key={s.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Badge style={{ fontSize: '0.7rem', flexShrink: 0 }}>{s.id}</Badge>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: '0.75rem',
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-fg-2)',
              }}
              title={s.urlTemplate}
            >
              {s.urlTemplate}
            </span>
            <Button variant="ghost" size="icon" onClick={() => move(idx, -1)} disabled={idx === 0}>
              <ArrowUp size={13} />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => move(idx, 1)} disabled={idx === sources.length - 1}>
              <ArrowDown size={13} />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => setSources((prev) => prev.filter((_, i) => i !== idx))}>
              <Trash2 size={13} />
            </Button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 6 }}>
          <Input value={newId} onChange={(e) => setNewId(e.target.value)} placeholder={t('settings:registry.sourceIdPh')} style={{ width: 140, flexShrink: 0 }} />
          <Input value={newTpl} onChange={(e) => setNewTpl(e.target.value)} placeholder={t('settings:registry.sourceTplPh')} />
          <Button variant="ghost" size="icon" onClick={addSource} disabled={!newId.trim() || !newTpl.trim()} aria-label={t('settings:registry.sourceAdd')}>
            <Plus size={14} />
          </Button>
        </div>
        <div>
          <Button variant="ghost" size="sm" onClick={() => setSources(DEFAULT_REGISTRY_SOURCES.map((s) => ({ ...s })))}>
            <RotateCcw size={13} />
            {t('settings:registry.sourcesReset')}
          </Button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button onClick={() => void onSave()} disabled={saveConfig.isPending || sources.length === 0}>
          {t('settings:registry.save')}
        </Button>
        {saveMsg ? <span style={{ fontSize: '0.8rem', color: 'var(--color-brand-600, var(--color-brand-500))' }}>{saveMsg}</span> : null}
        {saveErr ? <span role="alert" style={{ fontSize: '0.8rem', color: 'var(--color-danger)' }}>{saveErr}</span> : null}
      </div>
    </>
  )
}
