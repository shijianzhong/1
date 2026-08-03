import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  RegistryAgentManifest,
  RegistryAssetKind,
  RegistryCapabilityManifest,
  RegistryIndex,
  RegistrySkillManifest,
} from '@shared/types'
import { getRegistryCacheDir } from '../storage/paths'
import { registryFetch } from './client'
import {
  RegistryAgentManifestSchema,
  RegistryCapabilityManifestSchema,
  RegistryIndexSchema,
  RegistrySkillManifestSchema,
} from './schemas'
import { isValidSlug } from './sources'

// —— Registry 数据服务（docs/REGISTRY_PLAN.md §3.1/§4.3）——
// index/manifest 内存缓存 10 分钟；index 另落盘持久缓存，全部源不可达时回退展示（stale）。
// skill.zip 落 userData/cache/registry/skills/{slug}.zip，plan→apply 链路 5 分钟内复用。

const INDEX_CACHE_MS = 10 * 60 * 1000
const MANIFEST_CACHE_MS = 10 * 60 * 1000
const ZIP_CACHE_MS = 5 * 60 * 1000

let indexMemCache: { at: number; index: RegistryIndex } | null = null
const manifestMemCache = new Map<string, { at: number; manifest: unknown }>()

const KIND_DIR: Record<RegistryAssetKind, string> = {
  agent: 'agents',
  skill: 'skills',
  capability: 'capabilities',
}

function assertSlug(slug: string): void {
  if (!isValidSlug(slug)) {
    throw new Error(`registry_invalid_slug: ${slug}`)
  }
}

function getIndexCachePath(): string {
  return join(getRegistryCacheDir(), 'index.json')
}

async function persistIndexCache(index: RegistryIndex): Promise<void> {
  try {
    const p = getIndexCachePath()
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, JSON.stringify(index), 'utf8')
  } catch {
    // 缓存落盘失败不阻断主流程
  }
}

async function loadPersistedIndexCache(): Promise<RegistryIndex | null> {
  try {
    const raw = await readFile(getIndexCachePath(), 'utf8')
    const parsed = RegistryIndexSchema.safeParse(JSON.parse(raw))
    return parsed.success ? (parsed.data as RegistryIndex) : null
  } catch {
    return null
  }
}

/**
 * 拉取全局索引。stale=true 表示全部源不可达、返回的是本地持久缓存。
 * 无缓存可用时抛错（渲染层展示加载失败）。
 */
export async function getRegistryIndex(opts?: {
  force?: boolean
}): Promise<{ index: RegistryIndex; stale: boolean }> {
  if (!opts?.force && indexMemCache && Date.now() - indexMemCache.at < INDEX_CACHE_MS) {
    return { index: indexMemCache.index, stale: false }
  }
  try {
    const { data } = await registryFetch('index.json')
    const parsed = RegistryIndexSchema.safeParse(JSON.parse(data as string))
    if (!parsed.success) {
      throw new Error('registry_index_invalid')
    }
    const index = parsed.data as RegistryIndex
    indexMemCache = { at: Date.now(), index }
    void persistIndexCache(index)
    return { index, stale: false }
  } catch (error) {
    const cached = await loadPersistedIndexCache()
    if (cached) return { index: cached, stale: true }
    throw error
  }
}

type ManifestOf<K extends RegistryAssetKind> = K extends 'agent'
  ? RegistryAgentManifest
  : K extends 'skill'
    ? RegistrySkillManifest
    : RegistryCapabilityManifest

const MANIFEST_SCHEMA = {
  agent: RegistryAgentManifestSchema,
  skill: RegistrySkillManifestSchema,
  capability: RegistryCapabilityManifestSchema,
} as const

export async function getRegistryManifest<K extends RegistryAssetKind>(
  kind: K,
  slug: string,
): Promise<ManifestOf<K>> {
  assertSlug(slug)
  const cacheKey = `${kind}:${slug}`
  const hit = manifestMemCache.get(cacheKey)
  if (hit && Date.now() - hit.at < MANIFEST_CACHE_MS) {
    return hit.manifest as ManifestOf<K>
  }
  const { data } = await registryFetch(`${KIND_DIR[kind]}/${slug}/manifest.json`)
  const parsed = MANIFEST_SCHEMA[kind].safeParse(JSON.parse(data as string))
  if (!parsed.success) {
    throw new Error(`registry_manifest_invalid: ${kind}/${slug}`)
  }
  manifestMemCache.set(cacheKey, { at: Date.now(), manifest: parsed.data })
  return parsed.data as ManifestOf<K>
}

/**
 * 下载 skill.zip 到本地缓存（5 分钟内复用——planImport 列脚本后 applyImport 直接复用）。
 * 返回本地文件路径。
 */
export async function downloadSkillZip(slug: string): Promise<string> {
  assertSlug(slug)
  const dest = join(getRegistryCacheDir(), 'skills', `${slug}.zip`)
  try {
    const st = await stat(dest)
    if (Date.now() - st.mtimeMs < ZIP_CACHE_MS) return dest
  } catch {
    // 无缓存，走下载
  }
  const { data } = await registryFetch(`skills/${slug}/skill.zip`, { binary: true })
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, data as Buffer)
  return dest
}

/** 测试/调试用：清空内存缓存 */
export function resetRegistryCaches(): void {
  indexMemCache = null
  manifestMemCache.clear()
}
