import { safeStorage } from 'electron'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { getVaultPath } from '../storage/paths'
import { logger } from '../logger'

// —— LLM key 加密存储（§5.3 + 铁律3）——
// 用 Electron safeStorage（macOS Keychain / Win DPAPI / Linux libsecret），
// 比 Node crypto 自管密钥更安全；密钥不入渲染进程，渲染层经 IPC 读写。
//
// 存储：userData/vault.bin = JSON { [keyId]: base64(加密 blob) }
// 渲染层只见 keyId，明文 key 经主进程解密后传入 LLM client，不回传渲染层。

type VaultMap = Record<string, string> // keyId → base64(safeStorage blob)

function readVault(): VaultMap {
  const path = getVaultPath()
  if (!existsSync(path)) return {}
  try {
    const raw = readFileSync(path, 'utf8')
    return JSON.parse(raw) as VaultMap
  } catch (error) {
    logger.warn('[vault] 读取失败，重置空 vault', error)
    return {}
  }
}

function writeVault(map: VaultMap): void {
  const path = getVaultPath()
  mkdirSync(dirname(path), { recursive: true })
  // 原子写盘（§11.4）
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(map), 'utf8')
  renameSync(tmp, path)
}

/** safeStorage 是否可用（Linux 无 libsecret 时 false） */
export function isVaultAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

/** 存加密 key（base64 blob） */
export function setKey(keyId: string, plaintext: string): void {
  if (!isVaultAvailable()) {
    throw new Error('safeStorage 不可用（系统未提供密钥链）')
  }
  const map = readVault()
  map[keyId] = safeStorage.encryptString(plaintext).toString('base64')
  writeVault(map)
}

/** 取解密明文 key；不存在返回 null */
export function getKey(keyId: string): string | null {
  const map = readVault()
  const blob = map[keyId]
  if (!blob) return null
  if (!isVaultAvailable()) {
    throw new Error('safeStorage 不可用，无法解密 key')
  }
  try {
    return safeStorage.decryptString(Buffer.from(blob, 'base64'))
  } catch (error) {
    logger.error(`[vault] 解密 ${keyId} 失败`, error)
    return null
  }
}

/** 删除 key */
export function removeKey(keyId: string): void {
  const map = readVault()
  delete map[keyId]
  writeVault(map)
}
