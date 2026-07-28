import pkg from 'electron-updater'
import { app, BrowserWindow } from 'electron'
import { logger } from './logger'

const { autoUpdater } = pkg

// —— 自动更新（§六 + §11）——
// electron-updater，启动检查 + 定时。github releases 起步。
// dev 环境跳过（未打包时 checkForUpdates 会报错，catch 静默）。

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4h

let timer: NodeJS.Timeout | null = null

export function setupAutoUpdater(getMainWindow: () => BrowserWindow | null): void {
  // 未打包（dev）不启动定时检查
  if (!app.isPackaged) return

  autoUpdater.logger = logger
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    logger.info('[updater] 发现新版本', info.version)
    getMainWindow()?.webContents.send('updater:updateAvailable', info)
  })
  autoUpdater.on('update-downloaded', (info) => {
    logger.info('[updater] 更新已下载，退出后安装', info.version)
    getMainWindow()?.webContents.send('updater:updateDownloaded', info)
  })
  autoUpdater.on('error', (err) => {
    logger.warn('[updater] 错误', err)
  })

  // 启动检查 + 定时
  void checkForUpdates()
  timer = setInterval(() => void checkForUpdates(), CHECK_INTERVAL_MS)
}

export async function checkForUpdates(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    // dev 或无网络时静默
    logger.warn('[updater] 检查失败（可能 dev 或无网络）', err)
  }
}

/** 下载并退出安装 */
export async function downloadAndInstall(): Promise<void> {
  try {
    await autoUpdater.downloadUpdate()
    autoUpdater.quitAndInstall()
  } catch (err) {
    logger.error('[updater] 下载安装失败', err)
  }
}

export function stopAutoUpdater(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
