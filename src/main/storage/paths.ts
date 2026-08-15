import { app } from 'electron'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

// —— 存储路径管理（§5.2.1 + 铁律4）——
// 统一用 app.getPath('userData')，不硬编码 ~/.eclaw/。

const DB_FILE = 'one.db'
const DB_BACKUP_FILE = 'one.db.bak'
const CONFIG_DIR = 'config'
const DRAFTS_DIR = 'drafts'
const BG_DIR = 'bg'

export function getUserDataDir(): string {
  // vitest / 纯 Node 环境（无 Electron app）回退到 /tmp
  try {
    return app.getPath('userData')
  } catch {
    return join(tmpdir(), 'one-test-userdata')
  }
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

/** 用户可写层：风格画像目录（userData/config/style-profiles，内容生产 §2.3） */
export function getStyleProfilesDir(): string {
  return join(getConfigDir(), 'style-profiles')
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

/** registry 下载缓存（index 持久缓存 + skill zip 临时缓存） */
export function getRegistryCacheDir(): string {
  return join(getUserDataDir(), 'cache', 'registry')
}

// —— 内置资产出厂基线（docs/CONTENT_PIPELINE_PLAN.md §2.5）——
// 随包打包进 extraResources（build/builtin → builtin），首启经 seedBuiltinAssets
// 复制进 userData 可写层。开发环境回退源码 build/builtin（复用 index.ts 图标范式
// + opencli.ts resourcesPath 范式）。引擎零侵入——builtin 复制进 userData 后
// 与 custom 长得一模一样。

/** builtin 出厂基线根目录（只读，随包） */
export function getBuiltinResourcesDir(): string {
  // 打包：process.resourcesPath/builtin；开发：源码 build/builtin
  const devPath = join(__dirname, '..', '..', '..', 'build', 'builtin')
  try {
    if (app.isPackaged) {
      const packaged = join(process.resourcesPath, 'builtin')
      return existsSync(packaged) ? packaged : devPath
    }
  } catch {
    // vitest / 纯 Node（无 Electron app）：回退源码 build/builtin
  }
  return devPath
}

/** builtin agent 出厂源目录 */
export function getBuiltinAgentsDir(): string {
  return join(getBuiltinResourcesDir(), 'agents')
}

/** builtin capability 出厂源目录 */
export function getBuiltinCapabilitiesDir(): string {
  return join(getBuiltinResourcesDir(), 'capabilities')
}

/** builtin skill 出厂源目录 */
export function getBuiltinSkillsDir(): string {
  return join(getBuiltinResourcesDir(), 'skills')
}

/** builtin 样文出厂源目录 */
export function getBuiltinSampleArticlesDir(): string {
  return join(getBuiltinResourcesDir(), 'sample-articles')
}

/** builtin 模板出厂源目录 */
export function getBuiltinTemplatesDir(): string {
  return join(getBuiltinResourcesDir(), 'templates')
}

/** 用户可写层：样文目录（userData/config/sample-articles，首启复制 builtin 基线进此） */
export function getSampleArticlesPath(): string {
  return join(getConfigDir(), 'sample-articles')
}

/** 用户可写层：模板目录（userData/config/templates，首启复制 builtin 基线进此） */
export function getTemplatesPath(): string {
  return join(getConfigDir(), 'templates')
}
