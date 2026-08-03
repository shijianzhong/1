import { join } from 'node:path'
import type { RegistryConfig, RegistrySource } from '@shared/types'
import { DEFAULT_REGISTRY_SOURCES, REGISTRY_TOKEN_KEY_ID } from '@shared/types'
import { readJsonFile, writeJsonFile } from '../storage/json-store'
import { getConfigDir } from '../storage/paths'

// —— Registry 源配置（docs/REGISTRY_PLAN.md §4.1）——
// 国内可达性要求源抽象：不写死单一域名，按优先级逐源 fallback。
// 设置页（Phase 4）接管后落 userData/config/registry.json，缺省用默认源。

export { REGISTRY_TOKEN_KEY_ID }

export const DEFAULT_REGISTRY_REPO = 'shijianzhong/one-registry'
export const DEFAULT_REGISTRY_REF = 'main'

export const DEFAULT_SOURCES = DEFAULT_REGISTRY_SOURCES

export function getRegistryConfigPath(): string {
  return join(getConfigDir(), 'registry.json')
}

export function loadRegistryConfig(): RegistryConfig {
  const raw = readJsonFile<Partial<RegistryConfig>>(getRegistryConfigPath(), {})
  return {
    repo: typeof raw.repo === 'string' && raw.repo.trim() ? raw.repo.trim() : DEFAULT_REGISTRY_REPO,
    ref: typeof raw.ref === 'string' && raw.ref.trim() ? raw.ref.trim() : DEFAULT_REGISTRY_REF,
    sources:
      Array.isArray(raw.sources) && raw.sources.length > 0
        ? raw.sources.filter(
            (s): s is RegistrySource =>
              !!s && typeof s.id === 'string' && typeof s.urlTemplate === 'string',
          )
        : DEFAULT_SOURCES,
  }
}

export function saveRegistryConfig(cfg: RegistryConfig): void {
  writeJsonFile(getRegistryConfigPath(), cfg)
}

/** 按模板拼 URL（{repo}/{ref}/{path} 占位） */
export function buildSourceUrl(
  source: RegistrySource,
  repo: string,
  ref: string,
  path: string,
): string {
  return source.urlTemplate
    .replaceAll('{repo}', repo)
    .replaceAll('{ref}', ref)
    .replaceAll('{path}', path)
}

/**
 * Token 只发给 GitHub 系域名——自定义镜像/ghproxy 可能不可信，
 * 附带 Authorization 会泄漏用户 token。
 */
export function shouldAttachToken(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return (
      host === 'github.com' ||
      host.endsWith('.github.com') ||
      host === 'githubusercontent.com' ||
      host.endsWith('.githubusercontent.com')
    )
  } catch {
    return false
  }
}

/**
 * slug 合法性（小写字母/数字/连字符）。
 * 安全关键：slug 会拼进 URL path 和本地缓存文件路径，不校验会被 `../` 穿越。
 */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)
}
