import pkg from 'electron-updater'
import { app, BrowserWindow } from 'electron'
import { logger } from './logger'
import { isBenignNoReleaseError } from './updater-errors'

const { autoUpdater } = pkg

// —— 自动更新（§六 + §11）——
// electron-updater，启动检查 + 定时。github releases 起步。
// dev 环境跳过（未打包时 checkForUpdates 会报错，catch 静默）。
//
// 发布约定：CI 打 tag 时 ncipollo 默认 draft:true（人工复核后再 Publish）。
// draft release 对 /releases/latest 不可见 → electron-updater 报 406 /
// "Unable to find latest version"。这是预期态，不当作故障刷屏。

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4h
/** 冷启动后再查：避免与首屏 IPC/渲染抢带宽；也避开刚装完立刻失败的噪声感 */
const INITIAL_DELAY_MS = 15_000

let timer: NodeJS.Timeout | null = null
let initialTimer: NodeJS.Timeout | null = null
/** 同一次进程内「无生产 release」只记一次，避免 4h 定时重复刷 */
let loggedNoRelease = false

function logUpdaterFailure(err: unknown, context: string): void {
  if (isBenignNoReleaseError(err)) {
    if (!loggedNoRelease) {
      loggedNoRelease = true
      logger.info(
        '[updater] 暂无已发布版本（GitHub releases 均为 draft 或空），跳过自动更新。发布一个非 draft release 后即可生效。',
      )
    }
    return
  }
  // 只记短消息，避免把 GitHub HTML/CSP 整页刷进 main.log
  const msg = err instanceof Error ? err.message.split('\n')[0] : String(err)
  logger.warn(`[updater] ${context}: ${msg}`)
}

export function setupAutoUpdater(getMainWindow: () => BrowserWindow | null): void {
  // 未打包（dev）不启动定时检查
  if (!app.isPackaged) return

  // 不把 autoUpdater.logger 接到 electron-log：其 error 通道会把完整 feed/HTML 刷盘。
  // 统一走下面的 error 事件 + checkForUpdates catch。
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
    logUpdaterFailure(err, '错误')
  })

  // 延迟首检 + 定时
  initialTimer = setTimeout(() => void checkForUpdates(), INITIAL_DELAY_MS)
  timer = setInterval(() => void checkForUpdates(), CHECK_INTERVAL_MS)
}

export async function checkForUpdates(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    logUpdaterFailure(err, '检查失败')
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
  if (initialTimer) {
    clearTimeout(initialTimer)
    initialTimer = null
  }
}
