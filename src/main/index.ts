import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { registerIpcHandlers } from './ipc/index'
import { closeDb, getDb } from './storage/db'
import { logger } from './logger'

const isMac = process.platform === 'darwin'

// —— E2E 测试隔离：ONE_USER_DATA env 覆盖 userData 目录（每测试独立 SQLite + vault）——
if (process.env.ONE_USER_DATA) {
  app.setPath('userData', process.env.ONE_USER_DATA)
}

// —— 全局错误兜底（§11.5）：不静默退出 ——
process.on('uncaughtException', (error) => {
  logger.error('uncaughtException', error)
})
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', reason)
})

// —— preload 路径：sandbox 模式需 CJS 产物（out/preload/index.cjs）——
// 启动校验缺失则提示先 build，避免 preload 静默断导致渲染层裸暴露 Node。
const PRELOAD_PATH = join(__dirname, '../preload/index.cjs')

function resolvePreloadPath(): string {
  if (!existsSync(PRELOAD_PATH)) {
    const message = `preload 产物缺失：${PRELOAD_PATH}，请先 npm run build`
    logger.error(message)
    throw new Error(message)
  }
  return PRELOAD_PATH
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 760,
    backgroundColor: '#FCFCFD',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: resolvePreloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true, // §铁律1：渲染进程零 Node 特权，preload 也跑在沙箱
    },
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

// —— 单例锁（§六）：多开时聚焦已有窗口而非新开 ——
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [mainWindow] = BrowserWindow.getAllWindows()
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    getDb() // 初始化 SQLite（WAL + 迁移 + integrity_check，§11.4）
    registerIpcHandlers()
    createMainWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (!isMac) {
      app.quit()
    }
  })

  // —— 退出前关闭 DB 连接，防写一半断电 ——
  app.on('before-quit', () => {
    closeDb()
  })
}
