import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, join } from 'node:path'
import { app, BrowserWindow, dialog, nativeImage } from 'electron'
import {
  DEFAULT_THEME,
  type SystemPingResponse,
  type ThemeBackgroundConfig,
  type ThemeConfig,
} from '@shared/types'
import { withHandler } from './handler'
import { getBackgroundDir } from '../storage/paths'
import { registerCapabilitiesHandlers } from './capabilities'
import { registerAgentsHandlers } from './agents'
import { registerSkillsHandlers } from './skills'
import { registerModelsHandlers } from './models'
import { registerPersonaHandlers } from './persona'
import { registerSessionsHandlers } from './sessions'
import { registerTasksHandlers } from './tasks'
import { registerSecretsHandlers } from './secrets'
import { registerHomeHandlers } from './home'
import { registerOrchestrateHandlers } from './orchestrate'
import { registerNativeHandlers } from './native'
import { registerProvidersHandlers } from './providers'
import { registerRegistryHandlers } from './registry'
import { registerMcpHandlers } from './mcp'
import { startupMarkFromRenderer } from '../startup-log'

const THEME_FILE = 'theme.json'

// —— 原子写盘：临时文件 + rename（§11.4）——
async function ensureDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await ensureDir(filePath)
  // 临时名必须每次唯一：同文件并发写（如主题快速调整连发）若共用 pid 临时名，
  // 后者 writeFile 截断前者尚未 rename 的临时文件 → ENOENT 风暴
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`
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

// —— 背景图管理（§12.6.1）——
/** 背景图压缩上限：宽 1920px + JPEG 82。原图动辄几 MB，loadBackground 全量
 *  base64 过 IPC 进渲染内存（P2-2），压缩后通常几百 KB */
const BG_MAX_WIDTH = 1920
const BG_JPEG_QUALITY = 82

async function importBackground(filePath: string): Promise<{ imageId: string }> {
  const ext = extname(filePath).toLowerCase() || '.png'
  const imageId = randomUUID()
  const dir = getBackgroundDir()
  await mkdir(dir, { recursive: true })
  // 静态图统一压缩成 JPEG（gif 保留原样：重编码会丢动画）
  if (ext !== '.gif') {
    const img = nativeImage.createFromPath(filePath)
    if (!img.isEmpty()) {
      const { width } = img.getSize()
      const resized = width > BG_MAX_WIDTH ? img.resize({ width: BG_MAX_WIDTH }) : img
      await writeFile(join(dir, `${imageId}.jpg`), resized.toJPEG(BG_JPEG_QUALITY))
      return { imageId }
    }
  }
  const dest = join(dir, `${imageId}${ext}`)
  await copyFile(filePath, dest)
  return { imageId }
}

async function loadBackgroundDataUrl(
  bg: ThemeBackgroundConfig,
): Promise<{ dataUrl: string | null; stale?: boolean }> {
  if (bg.type !== 'image' || !bg.imageId) return { dataUrl: null }
  // 在 bg 目录找匹配 imageId 的文件
  const dir = getBackgroundDir()
  const { readdir } = await import('node:fs/promises')
  let found: string | null = null
  try {
    const files = await readdir(dir)
    found = files.find((f) => f.startsWith(bg.imageId!)) ?? null
    if (found) found = join(dir, found)
  } catch {
    // bg 目录不存在
  }
  if (!found || !existsSync(found)) {
    // path 失效（用户删了原图）→ stale
    return { dataUrl: null, stale: true }
  }
  const buf = await readFile(found)
  const ext = extname(found).slice(1) || 'png'
  return { dataUrl: `data:image/${ext};base64,${buf.toString('base64')}` }
}

async function removeBackgroundFile(imageId?: string): Promise<void> {
  if (!imageId) return
  const dir = getBackgroundDir()
  const { readdir } = await import('node:fs/promises')
  try {
    const files = await readdir(dir)
    for (const f of files) {
      if (f.startsWith(imageId)) {
        await unlink(join(dir, f)).catch(() => {})
      }
    }
  } catch {
    // 无目录
  }
}

export function registerIpcHandlers(): void {
  // —— system + theme ——
  withHandler<SystemPingResponse>('system:ping', (): SystemPingResponse => ({
    ok: true,
    appVersion: app.getVersion(),
    platform: process.platform,
  }))
  // 启动诊断埋点：渲染层上报，写入 userData/logs/startup.log
  withHandler<void>('system:startupMark', (_e, payloadRaw) => {
    const payload = payloadRaw as {
      phase?: string
      rendererT?: number
      detail?: Record<string, unknown>
    }
    if (payload?.phase) {
      startupMarkFromRenderer({
        phase: payload.phase,
        rendererT: payload.rendererT,
        detail: payload.detail,
      })
    }
  })
  withHandler<ThemeConfig>('theme:get', async () => loadTheme())
  withHandler<ThemeConfig>('theme:set', async (_event, themeRaw) =>
    saveTheme(themeRaw as ThemeConfig),
  )
  withHandler<{ filePath: string } | null>('theme:pickBackground', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return { filePath: result.filePaths[0] }
  })
  withHandler<{ imageId: string }>('theme:importBackground', async (_e, filePathRaw) => {
    const filePath = filePathRaw as string
    return importBackground(filePath)
  })
  withHandler<{ dataUrl: string | null; stale?: boolean }>(
    'theme:loadBackground',
    async (_e, bgRaw) => loadBackgroundDataUrl(bgRaw as ThemeBackgroundConfig),
  )
  withHandler<void>('theme:removeBackground', async (_e, imageIdRaw) =>
    removeBackgroundFile(imageIdRaw as string | undefined),
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
  registerOrchestrateHandlers()
  registerProvidersHandlers()
  registerRegistryHandlers()
  registerMcpHandlers()
  registerNativeHandlers(() => BrowserWindow.getAllWindows()[0] ?? null)
}
