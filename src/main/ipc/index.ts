import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import {
  DEFAULT_THEME,
  type SystemPingResponse,
  type ThemeConfig,
} from '@shared/types'
import { withHandler } from './handler'
import { registerCapabilitiesHandlers } from './capabilities'
import { registerAgentsHandlers } from './agents'
import { registerSkillsHandlers } from './skills'
import { registerModelsHandlers } from './models'
import { registerPersonaHandlers } from './persona'
import { registerSessionsHandlers } from './sessions'
import { registerTasksHandlers } from './tasks'
import { registerSecretsHandlers } from './secrets'
import { registerHomeHandlers } from './home'

const THEME_FILE = 'theme.json'

// —— 原子写盘：临时文件 + rename（§11.4）——
async function ensureDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await ensureDir(filePath)
  const tmp = `${filePath}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  try {
    await rename(tmp, filePath)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

function getThemePath(): string {
  return join(app.getPath('userData'), THEME_FILE)
}

async function loadTheme(): Promise<ThemeConfig> {
  try {
    const raw = await readFile(getThemePath(), 'utf8')
    return {
      ...DEFAULT_THEME,
      ...JSON.parse(raw),
    } as ThemeConfig
  } catch {
    return DEFAULT_THEME
  }
}

async function saveTheme(theme: ThemeConfig): Promise<ThemeConfig> {
  const nextTheme: ThemeConfig = { ...DEFAULT_THEME, ...theme }
  await writeJsonAtomic(getThemePath(), nextTheme)
  return nextTheme
}

export function registerIpcHandlers(): void {
  // —— system + theme ——
  withHandler<SystemPingResponse>('system:ping', (): SystemPingResponse => ({
    ok: true,
    appVersion: app.getVersion(),
    platform: process.platform,
  }))
  withHandler<ThemeConfig>('theme:get', async () => loadTheme())
  withHandler<ThemeConfig>('theme:set', async (_event, themeRaw) =>
    saveTheme(themeRaw as ThemeConfig),
  )

  // —— 阶段1 实体 CRUD ——
  registerCapabilitiesHandlers()
  registerAgentsHandlers()
  registerSkillsHandlers()
  registerModelsHandlers()
  registerPersonaHandlers()
  registerSessionsHandlers()
  registerTasksHandlers()
  registerSecretsHandlers()
  registerHomeHandlers()
}
