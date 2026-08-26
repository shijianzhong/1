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
const KB_MODEL_DIR = 'kb-models'

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

/**
 * generated/A 声明式插件目录（docs/PLUGIN_ARCHITECTURE.md §5 Stage 2）。
 * 磁盘事实：config/generated-plugins/<id>/manifest.json
 * 与 skills 同级（config 域，可写层、随包零依赖）。
 */
export function getGeneratedPluginsDir(): string {
  return join(getConfigDir(), 'generated-plugins')
}

/** 单个 generated 插件目录（config/generated-plugins/<id>） */
export function getGeneratedPluginDir(id: string): string {
  return join(getGeneratedPluginsDir(), id)
}

/** generated 插件 manifest 路径（config/generated-plugins/<id>/manifest.json） */
export function getGeneratedPluginManifestPath(id: string): string {
  return join(getGeneratedPluginDir(id), 'manifest.json')
}

/**
 * generated/B 代码型插件 handler 源码路径（docs/PLUGIN_ARCHITECTURE.md §5 Stage 3）。
 * 磁盘事实：config/generated-plugins/<id>/handler.js（与 manifest.json 同目录）。
 * B 复用 generated-plugins 目录根，靠 id 前缀 genb_ 与 A 的 gen_ 互斥（正则过滤无串扰）。
 */
export function getGeneratedBHandlerPath(id: string): string {
  return join(getGeneratedPluginDir(id), 'handler.js')
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

/**
 * 向量化知识库模型存储目录（docs/VECTOR_KB_PLAN.md §二）。
 * 运行时下载或 full 包首启从 resources 复制到此（userData/kb-models）。
 */
export function getKbModelDir(): string {
  return join(getUserDataDir(), KB_MODEL_DIR)
}

/**
 * full 包随包的预置模型权重出厂源（resources/kb-models；开发环境回退 build/kb-models）。
 * slim 包不存在 → 返回 devPath（seedKbModel 会 existsSync 判否 no-op）。
 */
export function getBuiltinKbModelDir(): string {
  // 打包：process.resourcesPath/kb-models；开发：源码 build/kb-models
  const devPath = join(__dirname, '..', '..', 'build', 'kb-models')
  try {
    if (app.isPackaged) {
      const packaged = join(process.resourcesPath, 'kb-models')
      return existsSync(packaged) ? packaged : devPath
    }
  } catch {
    // vitest / 纯 Node（无 Electron app）：回退源码 build/kb-models
  }
  return devPath
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
  const devPath = join(__dirname, '..', '..', 'build', 'builtin')
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

/**
 * 向量化推理 worker 脚本路径（docs/VECTOR_KB_PLAN.md §二，铁律23 同类）。
 * 随包 extraResources 分发（vector/worker-embed.cjs），主进程用 ELECTRON_RUN_AS_NODE
 * 拉起独立 node 子进程跑 transformers.js，不在主线程同步 encode。
 */
export function getKbWorkerScriptPath(): string {
  // 开发：源码 src/main/vector/worker-embed.cjs（经 electron-vite 后在 out/main 旁）
  const devPath = join(__dirname, '..', '..', 'src', 'main', 'vector', 'worker-embed.cjs')
  try {
    if (app.isPackaged) {
      const packaged = join(process.resourcesPath, 'vector', 'worker-embed.cjs')
      return existsSync(packaged) ? packaged : devPath
    }
  } catch {
    // vitest / 纯 Node（无 Electron app）：回退源码路径
  }
  return devPath
}

/**
 * 向量化推理 worker 的 node_modules 解析目录（packaged 下 worker require 的依赖根）。
 * 随包 extraResources 分发为 vector/node_modules（@xenova/transformers + onnxruntime-web）。
 */
export function getKbWorkerModulesDir(): string {
  const devPath = join(__dirname, '..', '..', '..', 'node_modules')
  try {
    if (app.isPackaged) {
      return join(process.resourcesPath, 'vector', 'node_modules')
    }
  } catch {
    // vitest / 纯 Node
  }
  return devPath
}
