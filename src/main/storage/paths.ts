import { app } from 'electron'
import { join } from 'node:path'

// —— 存储路径管理（§5.2.1 + 铁律4）——
// 统一用 app.getPath('userData')，不硬编码 ~/.eclaw/。

const DB_FILE = 'one.db'
const DB_BACKUP_FILE = 'one.db.bak'
const CONFIG_DIR = 'config'
const DRAFTS_DIR = 'drafts'
const BG_DIR = 'bg'

export function getUserDataDir(): string {
  return app.getPath('userData')
}

export function getDbPath(): string {
  return join(getUserDataDir(), DB_FILE)
}

export function getDbBackupPath(): string {
  return join(getUserDataDir(), DB_BACKUP_FILE)
}

/** 损坏库备份命名：one.db.corrupt-<ts> */
export function getCorruptDbPath(): string {
  return join(getUserDataDir(), `one.db.corrupt-${Date.now()}`)
}

export function getConfigDir(): string {
  return join(getUserDataDir(), CONFIG_DIR)
}

export function getModelsPath(): string {
  return join(getConfigDir(), 'models.json')
}

export function getProvidersPath(): string {
  return join(getConfigDir(), 'providers.json')
}

export function getCapabilitiesDir(): string {
  return join(getConfigDir(), 'capabilities')
}

export function getAgentsPath(): string {
  return join(getConfigDir(), 'agents')
}

export function getSkillsPath(): string {
  return join(getConfigDir(), 'skills')
}

export function getPersonaPath(): string {
  return join(getConfigDir(), 'persona.json')
}

export function getVaultPath(): string {
  return join(getUserDataDir(), 'vault.bin')
}

export function getDraftsDir(): string {
  return join(getUserDataDir(), DRAFTS_DIR)
}

export function getBackgroundDir(): string {
  return join(getUserDataDir(), BG_DIR)
}
