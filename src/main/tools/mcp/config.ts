import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { McpServerConfig } from '@shared/types'
import { logger } from '../../logger'

// —— MCP 服务器配置持久化（config/mcp-servers.json）——
// 原子写盘：临时文件 + rename，与 ipc/index.ts writeJsonAtomic 同策略。

const CONFIG_FILE = 'mcp-servers.json'

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

export async function addMcpServer(
  input: Omit<McpServerConfig, 'id'>,
): Promise<McpServerConfig> {
  const servers = await loadMcpConfig()
  const config: McpServerConfig = { ...input, id: randomUUID() }
  servers.push(config)
  await saveMcpConfig(servers)
  logger.info(`[mcp] added server: ${config.name} (${config.id})`)
  return config
}

export async function updateMcpServer(
  id: string,
  input: Partial<Omit<McpServerConfig, 'id'>>,
): Promise<McpServerConfig | null> {
  const servers = await loadMcpConfig()
  const idx = servers.findIndex((s) => s.id === id)
  if (idx === -1) return null
  servers[idx] = { ...servers[idx], ...input, id }
  await saveMcpConfig(servers)
  logger.info(`[mcp] updated server: ${servers[idx].name} (${id})`)
  return servers[idx]
}

export async function removeMcpServer(id: string): Promise<boolean> {
  const servers = await loadMcpConfig()
  const idx = servers.findIndex((s) => s.id === id)
  if (idx === -1) return false
  servers.splice(idx, 1)
  await saveMcpConfig(servers)
  logger.info(`[mcp] removed server: ${id}`)
  return true
}
