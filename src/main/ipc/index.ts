import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  DEFAULT_THEME,
  err,
  isIpcFailure,
  ok,
  type IpcResult,
  type SystemPingResponse,
  type ThemeConfig,
} from '@shared/types'
import { logger } from '../logger'

const THEME_FILE = 'theme.json'

// —— withHandler：所有 ipcMain.handle 统一 try/catch，返回结构化 IpcResult（§11.3）——
// 失败不抛未捕获异常，渲染层据 isIpcFailure 判定并按 retryable 重试。
type InvokeHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown | Promise<unknown>

function withHandler<T>(channel: string, handler: InvokeHandler): void {
  ipcMain.handle(channel, async (event, ...args): Promise<IpcResult<T>> => {
    try {
      const data = (await handler(event, ...args)) as T
      return ok(data)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const retryable = isTransient(error)
      logger.error(`[ipc:${channel}]`, error)
      return err(`ipc.${channel}`, message, retryable)
    }
  })
}

function isTransient(error: unknown): boolean {
  const name = error instanceof Error ? error.name : ''
  const msg = error instanceof Error ? error.message : String(error)
  return (
    name.includes('Network') ||
    /timeout|connection|temporarily|busy|locked/i.test(msg)
  )
}

// —— 原子写盘：临时文件 + rename（§11.4），防覆盖中途崩溃留半截状态 ——
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
  withHandler<SystemPingResponse>('system:ping', (): SystemPingResponse => ({
    ok: true,
    appVersion: app.getVersion(),
    platform: process.platform,
  }))

  withHandler<ThemeConfig>('theme:get', async () => loadTheme())
  withHandler<ThemeConfig>('theme:set', async (_event, themeRaw) =>
    saveTheme(themeRaw as ThemeConfig),
  )
}

// 供渲染层类型推导：渲染 api/ 调 window.one.* 后用 isIpcFailure 解包
export { isIpcFailure }
