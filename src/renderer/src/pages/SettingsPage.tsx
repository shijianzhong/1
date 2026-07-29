import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ImagePlus, Trash2 } from 'lucide-react'
import { useThemeStore } from '@renderer/store/theme'
import { DEFAULT_THEME } from '@shared/types'
import type { Persona, Provider, ThemeBackgroundConfig, ThemeConfig } from '@shared/types'
import { Button } from '@renderer/components/ui/Button'
import { Switch } from '@renderer/components/ui/Switch'
import { Input } from '@renderer/components/ui/Input'
import { Badge } from '@renderer/components/ui/Badge'
import { unwrap } from '@renderer/api/client'
import {
  usePersona,
  useSavePersona,
  useProviders,
} from '@renderer/api/hooks'

// —— 设置页（§4 + §12.6.1）——
// 外观全量：预设/明暗/点缀色色板/背景图导入/玻璃参数/密度/字号。
// 玻璃做容器分区，表单内容实色保证可读。

const PRESETS = [
  { value: 'pure-white', key: 'pureWhite' },
  { value: 'warm', key: 'warm' },
  { value: 'dark', key: 'dark' },
] as const

const ACCENT_PRESETS = [
  '#4ECDC4', // 薄荷绿
  '#5BA8E8', // 天空蓝
  '#9BC53B', // 青柠
  '#E8A0BF', // 蜜桃粉
  '#E0A93C', // 暖琥珀
  '#9B7EDC', // 紫罗兰
]

const DENSITIES: Array<ThemeConfig['density']> = ['comfortable', 'compact', 'spacious']

export function SettingsPage() {
  const { t } = useTranslation(['settings', 'common'])
  const theme = useThemeStore((state) => state.theme)
  const saveTheme = useThemeStore((state) => state.save)
  const [bgDataUrl, setBgDataUrl] = useState<string | null>(null)

  // —— 个人档案 + LLM 配置（供应商为中心，cc switch 范式）——
  const personaQ = usePersona()
  const savePersona = useSavePersona()
  const providersQ = useProviders()
  const persona = personaQ.data ?? null
  const [profile, setProfile] = useState<NonNullable<Persona['profile']>>({
    alias: '',
    role: '',
    preferredLanguage: 'zh-CN',
  })
  // 每供应商 key 输入
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({})
  // 每供应商 key 是否已配置
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (persona?.profile) setProfile(persona.profile)
  }, [persona?.profile])

  // 查询每供应商 key 状态
  useEffect(() => {
    for (const p of providersQ.data ?? []) {
      if (!p.keyId) continue
      void window.one.secrets
        .getLLMConfig(p.keyId)
        .then((r) => {
          if ('data' in r) setKeyStatus((s) => ({ ...s, [p.id]: r.data.hasKey }))
        })
        .catch(() => {})
    }
  }, [providersQ.data])

  // profile 直接存 persona（更新 profile 字段）
  const saveProfile = async (): Promise<void> => {
    const p: Persona = {
      id: 'home',
      name: persona?.name ?? t('settings:profile.defaultName'),
      instructions: persona?.instructions ?? '',
      modelId: persona?.modelId,
      profile,
      updatedAt: Date.now(),
    }
    void savePersona.mutateAsync({
      name: p.name,
      instructions: p.instructions,
      modelId: p.modelId,
    } as never).catch(() => {})
  }

  // 保存供应商 key 到 vault
  const onSaveKey = async (p: Provider): Promise<void> => {
    const val = keyInputs[p.id]
    if (!p.keyId || !val) return
    await window.one.secrets
      .setLLMConfig({ keyId: p.keyId, apiKey: val })
      .then(unwrap)
      .catch(() => {})
    setKeyInputs((s) => ({ ...s, [p.id]: '' }))
    setKeyStatus((s) => ({ ...s, [p.id]: true }))
  }

  // 背景图 dataUrl
  useEffect(() => {
    if (theme.background?.type === 'image' && theme.background.imageId) {
      void window.one.theme
        .loadBackground(theme.background)
        .then((r) => {
          if ('data' in r && r.data) setBgDataUrl(r.data.dataUrl)
        })
        .catch(() => {})
    } else {
      setBgDataUrl(null)
    }
  }, [theme.background])

  const update = (patch: Partial<ThemeConfig>): void => {
    void saveTheme({ ...theme, ...patch })
  }

  const onPickBackground = async (): Promise<void> => {
    const picked = await window.one.theme.pickBackground().then(unwrap)
    if (!picked) return
    const imported = await window.one.theme.importBackground(picked.filePath).then(unwrap)
    const bg: ThemeBackgroundConfig = {
      type: 'image',
      imageId: imported.imageId,
      blurPx: theme.background?.blurPx ?? 0,
      dimAmount: theme.background?.dimAmount ?? 0,
      position: 'cover',
    }
    update({ background: bg })
  }

  const onRemoveBackground = async (): Promise<void> => {
    if (theme.background?.imageId) {
      await window.one.theme.removeBackground(theme.background.imageId).then(unwrap).catch(() => {})
    }
    update({ background: { type: 'none' } })
    setBgDataUrl(null)
  }

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', display: 'grid', gap: 16 }}>
      {/* 个人档案（L0 身份块来源） */}
      <SectionCard title={t('settings:profile.title')} subtitle={t('settings:profile.subtitle')}>
        <Row label={t('settings:profile.alias')}>
          <Input
            value={profile.alias ?? ''}
            onChange={(e) => setProfile((p) => ({ ...p, alias: e.target.value }))}
            style={{ width: 220 }}
          />
        </Row>
        <Row label={t('settings:profile.role')}>
          <Input
            value={profile.role ?? ''}
            onChange={(e) => setProfile((p) => ({ ...p, role: e.target.value }))}
            style={{ width: 220 }}
          />
        </Row>
        <Row label={t('settings:profile.language')}>
          <select
            value={profile.preferredLanguage ?? 'zh-CN'}
            onChange={(e) =>
              setProfile((p) => ({
                ...p,
                preferredLanguage: e.target.value as 'zh-CN' | 'en',
              }))
            }
            style={{
              height: 36,
              borderRadius: 12,
              border: '1px solid var(--color-border)',
              background: 'var(--color-bg-1)',
              color: 'var(--color-fg-1)',
              padding: '0 10px',
            }}
          >
            <option value="zh-CN">中文</option>
            <option value="en">English</option>
          </select>
        </Row>
        <Button variant="secondary" size="sm" onClick={() => void saveProfile()}>
          {t('common:actions.save')}
        </Button>
      </SectionCard>

      {/* 预设 */}
      <SectionCard title={t('settings:appearance.title')} subtitle={t('settings:appearance.subtitle')}>
        <div className="placeholder-grid">
          {PRESETS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              className="surface-panel placeholder-card"
              onClick={() =>
                update({
                  preset: preset.value,
                  mode: preset.value === 'dark' ? 'dark' : 'light',
                })
              }
              style={{
                borderRadius: 16,
                textAlign: 'left',
                cursor: 'pointer',
                outline:
                  theme.preset === preset.value ? '2px solid var(--color-brand-500)' : 'none',
              }}
            >
              <h3 className="section-title">{t(`settings:appearance.presets.${preset.key}`)}</h3>
            </button>
          ))}
        </div>
      </SectionCard>

      {/* 明暗模式 */}
      <SectionCard title={t('settings:appearance.modeTitle')}>
        <Row label={t('settings:appearance.followSystem')}>
          <Switch
            checked={theme.mode === 'system'}
            onCheckedChange={(c) => update({ mode: c ? 'system' : 'light' })}
          />
        </Row>
      </SectionCard>

      {/* 点缀色 */}
      <SectionCard title={t('settings:appearance.accentTitle')}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {ACCENT_PRESETS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => update({ accent: c })}
              style={{
                width: 36,
                height: 36,
                borderRadius: '50%',
                border:
                  theme.accent === c
                    ? '2px solid var(--color-fg-1)'
                    : '2px solid var(--color-border)',
                background: c,
                cursor: 'pointer',
              }}
              aria-label={c}
            />
          ))}
        </div>
      </SectionCard>

      {/* 背景图 */}
      <SectionCard title={t('settings:appearance.backgroundTitle')}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {bgDataUrl ? (
            <img
              src={bgDataUrl}
              alt="background"
              style={{ width: 80, height: 50, objectFit: 'cover', borderRadius: 8 }}
            />
          ) : (
            <div
              style={{
                width: 80,
                height: 50,
                borderRadius: 8,
                background: 'var(--color-bg-3)',
              }}
            />
          )}
          <Button variant="secondary" size="sm" onClick={() => void onPickBackground()}>
            <ImagePlus size={14} /> {t('settings:appearance.importBg')}
          </Button>
          {theme.background?.type === 'image' ? (
            <Button variant="ghost" size="sm" onClick={() => void onRemoveBackground()}>
              <Trash2 size={14} />
            </Button>
          ) : null}
        </div>
        {theme.background?.type === 'image' ? (
          <>
            <SliderRow
              label={t('settings:appearance.blur')}
              value={theme.background.blurPx ?? 0}
              min={0}
              max={30}
              onChange={(v) => update({ background: { ...theme.background!, blurPx: v } })}
            />
            <SliderRow
              label={t('settings:appearance.dim')}
              value={Math.round((theme.background.dimAmount ?? 0) * 100)}
              min={0}
              max={60}
              onChange={(v) =>
                update({ background: { ...theme.background!, dimAmount: v / 100 } })
              }
            />
          </>
        ) : null}
      </SectionCard>

      {/* 玻璃参数 */}
      <SectionCard title={t('settings:appearance.glassTitle')}>
        <SliderRow
          label={t('settings:appearance.glassBlur')}
          value={theme.glassBlur ?? 16}
          min={0}
          max={40}
          onChange={(v) => update({ glassBlur: v })}
        />
        <SliderRow
          label={t('settings:appearance.glassOpacity')}
          value={Math.round((theme.glassOpacity ?? 0.6) * 100)}
          min={20}
          max={95}
          onChange={(v) => update({ glassOpacity: v / 100 })}
        />
      </SectionCard>

      {/* 密度 + 字号 */}
      <SectionCard title={t('settings:appearance.layoutTitle')}>
        <Row label={t('settings:appearance.density')}>
          <div style={{ display: 'flex', gap: 8 }}>
            {DENSITIES.map((d) => (
              <Button
                key={d}
                variant={theme.density === d ? 'default' : 'secondary'}
                size="sm"
                onClick={() => update({ density: d })}
              >
                {t(`settings:appearance.densities.${d}`)}
              </Button>
            ))}
          </div>
        </Row>
        <SliderRow
          label={t('settings:appearance.fontScale')}
          value={Math.round((theme.fontScale ?? 1) * 100)}
          min={80}
          max={130}
          onChange={(v) => update({ fontScale: v / 100 })}
        />
      </SectionCard>

      {/* LLM 配置（无登录，本地单用户）—— 模型列表 + key 管理 */}
      {/* LLM 配置（供应商为中心）—— 显示供应商 + key 输入，完整编辑去模型页 */}
      <SectionCard title={t('settings:llm.title')} subtitle={t('settings:llm.subtitle')}>
        {(providersQ.data ?? []).length === 0 ? (
          <p className="section-subtitle">{t('settings:llm.empty')}</p>
        ) : (
          (providersQ.data ?? []).map((p) => (
            <div
              key={p.id}
              className="surface-panel"
              style={{ borderRadius: 14, padding: 14, display: 'grid', gap: 10 }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <span style={{ fontWeight: 500, fontSize: '0.9rem' }}>{p.name}</span>
                  {p.apiFormat ? (
                    <Badge variant="brand" style={{ marginLeft: 8, fontSize: '0.7rem' }}>
                      {p.apiFormat}
                    </Badge>
                  ) : null}
                  <p className="section-subtitle" style={{ margin: '4px 0 0' }}>
                    {p.baseUrl ? `${p.baseUrl} · ` : ''}主:{p.models.primary ?? '-'}
                    {p.models.reasoning ? ` · 推理:${p.models.reasoning}` : ''}
                    {p.models.fast ? ` · 快答:${p.models.fast}` : ''}
                  </p>
                </div>
              </div>
              {/* key 输入 */}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Input
                  type="password"
                  placeholder={keyStatus[p.id] ? '••••••••（已配置，留空不改）' : t('settings:llm.apiKey')}
                  value={keyInputs[p.id] ?? ''}
                  onChange={(e) => setKeyInputs((s) => ({ ...s, [p.id]: e.target.value }))}
                  style={{ flex: 1 }}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void onSaveKey(p)}
                  disabled={!keyInputs[p.id]}
                >
                  {t('common:actions.save')}
                </Button>
              </div>
            </div>
          ))
        )}
      </SectionCard>

      {/* 关于 */}
      <SectionCard title={t('settings:about.title')}>
        <Row label={t('settings:about.version')}>
          <span style={{ color: 'var(--color-fg-2)', fontSize: '0.875rem' }}>0.1.0</span>
        </Row>
        <Button variant="ghost" size="sm" onClick={() => void window.one.system.ping().then(unwrap).then(() => {}).catch(() => {})}>
          {t('settings:about.checkUpdate')}
        </Button>
      </SectionCard>

      <Button variant="secondary" onClick={() => void saveTheme(DEFAULT_THEME)}>
        {t('common:actions.reset')}
      </Button>
    </div>
  )
}

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <section
      className="glass-panel"
      style={{ borderRadius: 20, padding: 20, display: 'grid', gap: 14 }}
    >
      <div>
        <h2 className="section-title" style={{ fontSize: '0.9rem' }}>
          {title}
        </h2>
        {subtitle ? <p className="section-subtitle">{subtitle}</p> : null}
      </div>
      <div style={{ display: 'grid', gap: 10 }}>{children}</div>
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        minHeight: 40,
        borderBottom: '1px solid var(--color-border)',
      }}
    >
      <span style={{ fontSize: '0.875rem', color: 'var(--color-fg-2)' }}>{label}</span>
      {children}
    </div>
  )
}

function SliderRow({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (v: number) => void
}) {
  return (
    <Row label={`${label}（${value}）`}>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ accentColor: 'var(--color-brand-500)' }}
      />
    </Row>
  )
}
