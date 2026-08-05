import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { McpServerConfig } from '@shared/types'
import { logger } from '../../logger'
import { setKey, getKey, removeKey, isVaultAvailable } from '../../secrets/vault'

// —— MCP 服务器配置持久化（config/mcp-servers.json）——
// 原子写盘：临时文件 + rename，与 ipc/index.ts writeJsonAtomic 同策略。
// I3 修复：env/headers 密钥走 vault 加密存储，配置文件只存 vault 引用标记。

const CONFIG_FILE = 'mcp-servers.json'
const VAULT_PREFIX = 'vault:'
const VAULT_KEY_PREFIX = 'mcp:'

function getConfigPath(): string {
  return join(app.getPath('userData'), 'config', CONFIG_FILE)
}

interface McpConfigFile {
  servers: McpServerConfig[]
}

export async function loadMcpConfig(): Promise<McpServerConfig[]> {
  try {
    const raw = await readFile(getConfigPath(), 'utf8')
    const data = JSON.parse(raw) as McpConfigFile
    return data.servers ?? []
  } catch {
    return []
  }
}

async function saveMcpConfig(servers: McpServerConfig[]): Promise<void> {
  const filePath = getConfigPath()
  await mkdir(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify({ servers }, null, 2), 'utf8')
  try {
    await rename(tmp, filePath)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

// —— I3: vault 密钥管理 ——

/** 将 env/headers 敏感值存入 vault，配置文件只保留 vault 引用标记 */
function encryptSecrets(config: McpServerConfig): McpServerConfig {
  if (!isVaultAvailable()) return config // vault 不可用（Linux 无 libsecret），保留明文

  const result = { ...config }

  if (result.env) {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(result.env)) {
      if (v && !v.startsWith(VAULT_PREFIX)) {
        const keyId = `${VAULT_KEY_PREFIX}${config.id}:env:${k}`
        setKey(keyId, v)
        env[k] = `${VAULT_PREFIX}${keyId}`
      } else {
        env[k] = v
      }
    }
    result.env = env
  }

  if (result.headers) {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(result.headers)) {
      if (v && !v.startsWith(VAULT_PREFIX)) {
        const keyId = `${VAULT_KEY_PREFIX}${config.id}:header:${k}`
        setKey(keyId, v)
        headers[k] = `${VAULT_PREFIX}${keyId}`
      } else {
        headers[k] = v
      }
    }
    result.headers = headers
  }

  return result
}

/** 解析 vault 引用标记 → 明文（connectServer 调用前用；testServer 传明文 → no-op） */
export function resolveSecrets(config: McpServerConfig): McpServerConfig {
  const result = { ...config }

  if (result.env) {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(result.env)) {
      if (v && v.startsWith(VAULT_PREFIX)) {
        const keyId = v.slice(VAULT_PREFIX.length)
        env[k] = getKey(keyId) ?? ''
      } else {
        env[k] = v
      }
    }
    result.env = env
  }

  if (result.headers) {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(result.headers)) {
      if (v && v.startsWith(VAULT_PREFIX)) {
        const keyId = v.slice(VAULT_PREFIX.length)
        headers[k] = getKey(keyId) ?? ''
      } else {
        headers[k] = v
      }
    }
    result.headers = headers
  }

  return result
}

/** 脱敏配置（IPC listServers 返回用）：env/headers 值打码，键名保留 */
export function sanitizeConfig(config: McpServerConfig): McpServerConfig {
  const result = { ...config }

  if (result.env) {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(result.env)) {
      env[k] = v ? '••••••••' : v
    }
    result.env = env
  }

  if (result.headers) {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(result.headers)) {
      headers[k] = v ? '••••••••' : v
    }
    result.headers = headers
  }

  return result
}

/** 删除 server 在 vault 中的所有密钥（removeMcpServer 调用） */
function purgeVaultKeys(config: McpServerConfig): void {
  if (!isVaultAvailable()) return
  if (config.env) {
    for (const k of Object.keys(config.env)) {
      removeKey(`${VAULT_KEY_PREFIX}${config.id}:env:${k}`)
    }
  }
  if (config.headers) {
    for (const k of Object.keys(config.headers)) {
      removeKey(`${VAULT_KEY_PREFIX}${config.id}:header:${k}`)
    }
  }
}

export async function addMcpServer(
  input: Omit<McpServerConfig, 'id'>,
): Promise<McpServerConfig> {
  const servers = await loadMcpConfig()
  const config: McpServerConfig = {
    ...input,
    id: randomUUID(),
    // 默认不注入 agent，需用户显式勾选 exposeToAgents（R2）
    exposeToAgents: input.exposeToAgents ?? false,
  }
  const encrypted = encryptSecrets(config)
  servers.push(encrypted)
  await saveMcpConfig(servers)
  logger.info(`[mcp] added server: ${config.name} (${config.id})`)
  // R3：IPC 回传脱敏视图，永不把明文/vault 引用交给渲染层
  return sanitizeConfig(encrypted)
}

export async function updateMcpServer(
  id: string,
  input: Partial<Omit<McpServerConfig, 'id'>>,
): Promise<McpServerConfig | null> {
  const servers = await loadMcpConfig()
  const idx = servers.findIndex((s) => s.id === id)
  if (idx === -1) return null
  // 合并：旧值（含 vault 引用）+ 新值（明文）
  const merged = { ...servers[idx], ...input, id }
  // 重新加密（新值存 vault，旧 vault 引用被覆盖）
  const encrypted = encryptSecrets(merged)
  servers[idx] = encrypted
  await saveMcpConfig(servers)
  logger.info(`[mcp] updated server: ${servers[idx].name} (${id})`)
  return sanitizeConfig(encrypted)
}

export async function removeMcpServer(id: string): Promise<boolean> {
  const servers = await loadMcpConfig()
  const idx = servers.findIndex((s) => s.id === id)
  if (idx === -1) return false
  // 清理 vault 中的密钥
  purgeVaultKeys(servers[idx])
  servers.splice(idx, 1)
  await saveMcpConfig(servers)
  logger.info(`[mcp] removed server: ${id}`)
  return true
}
