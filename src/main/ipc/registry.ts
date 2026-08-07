import type {
  RegistryAssetKind,
  RegistryConfig,
  RegistryExportConfirmItem,
  RegistryExportPlan,
  RegistryExportResult,
  RegistryImportPlan,
  RegistryImportResult,
  RegistryIndex,
} from '@shared/types'
import { IpcErrorThrow } from '@shared/types'
import { BrowserWindow, dialog, shell } from 'electron'
import { applyExport, getContributeUrl, planExport } from '../registry/exporter'
import { applyImport, planImport } from '../registry/importer'
import { getRepoStats, submitExportAsPr } from '../registry/publisher'
import { getRegistryIndex, getRegistryManifest, resetRegistryCaches } from '../registry/service'
import { isValidSlug, loadRegistryConfig, saveRegistryConfig } from '../registry/sources'
import { withHandler } from './handler'

// —— Registry IPC（docs/REGISTRY_PLAN.md §3.1/§3.2/§3.3）——
// 浏览：getIndex（10min 缓存 + stale 回退）/ getManifest；
// 导入：planImport（依赖树 + 脚本清单）→ 渲染层确认 → applyImport；
// 导出：planExport（级联清单）→ 渲染层编辑 slug/version + 勾选 → applyExport（选目录落盘 + provenance 回写）。

const KINDS: RegistryAssetKind[] = ['agent', 'skill', 'capability']

function parseKind(raw: unknown): RegistryAssetKind {
  if (typeof raw !== 'string' || !KINDS.includes(raw as RegistryAssetKind)) {
    throw new Error(`registry_invalid_kind: ${String(raw)}`)
  }
  return raw as RegistryAssetKind
}

function parseSlug(raw: unknown): string {
  if (typeof raw !== 'string' || !isValidSlug(raw)) {
    throw new Error(`registry_invalid_slug: ${String(raw)}`)
  }
  return raw
}

/** 设置页保存校验（§4.4）：repo/ref 格式 + 源模板必须含 {path} 占位 + id 去重 */
function parseConfig(raw: unknown): RegistryConfig {
  const cfg = raw as Partial<RegistryConfig>
  if (typeof cfg?.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(cfg.repo.trim())) {
    throw new IpcErrorThrow('errors.registry.invalid_repo', `registry_invalid_repo: ${String(cfg?.repo)}`)
  }
  if (typeof cfg?.ref !== 'string' || !cfg.ref.trim()) {
    throw new IpcErrorThrow('errors.registry.invalid_ref', `registry_invalid_ref: ${String(cfg?.ref)}`)
  }
  if (!Array.isArray(cfg?.sources) || cfg.sources.length === 0) {
    throw new IpcErrorThrow('errors.registry.invalid_sources')
  }
  const seen = new Set<string>()
  const sources = cfg.sources.map((s) => {
    const id = typeof s?.id === 'string' ? s.id.trim() : ''
    const urlTemplate = typeof s?.urlTemplate === 'string' ? s.urlTemplate.trim() : ''
    if (!id || seen.has(id)) throw new IpcErrorThrow('errors.registry.invalid_source_id', `registry_invalid_source_id: ${id}`)
    seen.add(id)
    if (!urlTemplate.startsWith('https://') || !urlTemplate.includes('{path}')) {
      throw new IpcErrorThrow('errors.registry.invalid_source_template', `registry_invalid_source_template: ${id}`)
    }
    return { id, urlTemplate }
  })
  return { repo: cfg.repo.trim(), ref: cfg.ref.trim(), sources }
}

export function registerRegistryHandlers(): void {
  withHandler<RegistryConfig>('registry:getConfig', () => loadRegistryConfig())

  withHandler<RegistryConfig>('registry:saveConfig', (_e, raw) => {
    const cfg = parseConfig(raw)
    saveRegistryConfig(cfg)
    resetRegistryCaches() // repo/源变更后旧缓存立即失效
    return loadRegistryConfig()
  })

  withHandler<{ index: RegistryIndex; stale: boolean }>('registry:getIndex', async (_e, forceRaw) =>
    getRegistryIndex({ force: forceRaw === true }),
  )

  withHandler<unknown>('registry:getManifest', async (_e, kindRaw, idRaw) =>
    getRegistryManifest(parseKind(kindRaw), parseSlug(idRaw)),
  )

  withHandler<RegistryImportPlan>('registry:planImport', async (_e, inputRaw) => {
    const input = inputRaw as { kind?: unknown; id?: unknown }
    return planImport(parseKind(input?.kind), parseSlug(input?.id))
  })

  withHandler<RegistryImportResult>('registry:applyImport', async (_e, inputRaw) => {
    const input = inputRaw as { kind?: unknown; id?: unknown; materializeAgents?: unknown }
    return applyImport(parseKind(input?.kind), parseSlug(input?.id), {
      materializeAgents: input?.materializeAgents !== false,
    })
  })

  withHandler<RegistryExportPlan>('registry:planExport', (_e, inputRaw) => {
    const input = inputRaw as { kind?: unknown; localId?: unknown }
    if (typeof input?.localId !== 'string' || !input.localId) {
      throw new Error(`registry_invalid_local_id: ${String(input?.localId)}`)
    }
    return planExport(parseKind(input?.kind), input.localId)
  })

  withHandler<RegistryExportResult | null>('registry:applyExport', async (e, inputRaw) => {
    const items = inputRaw as RegistryExportConfirmItem[]
    if (!Array.isArray(items) || items.length === 0) throw new IpcErrorThrow('errors.registry.export_empty')
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
    const picked = await dialog.showOpenDialog(win, {
      title: '选择导出目录（将在其中创建 one-registry-export/）',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    const result = await applyExport(items, picked.filePaths[0])
    shell.showItemInFolder(result.dir)
    return result
  })

  withHandler<void>('registry:openContribute', () => shell.openExternal(getContributeUrl()))

  withHandler<{ prUrl: string; prNumber: number; reused?: boolean }>(
    'registry:submitPr',
    async (_e, inputRaw) => {
      const input = inputRaw as { dir?: unknown; files?: unknown; items?: unknown }
      if (typeof input?.dir !== 'string' || !input.dir) throw new IpcErrorThrow('errors.registry.pr_missing_dir')
      if (!Array.isArray(input?.files) || !Array.isArray(input?.items) || input.items.length === 0) {
        throw new IpcErrorThrow('errors.registry.pr_missing_manifest')
      }
      const result = await submitExportAsPr(
        input.dir,
        input.files as string[],
        input.items as RegistryExportConfirmItem[],
      )
      // 创建/复用成功直接在浏览器打开 PR 页
      void shell.openExternal(result.prUrl)
      return result
    },
  )

  withHandler<{ stars: number; forks: number }>('registry:getRepoStats', () => getRepoStats())
}
