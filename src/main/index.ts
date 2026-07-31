import './bootstrap-userdata' // 必须最先：ONE_USER_DATA 覆盖 userData，早于 storage 模块初始化
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { registerIpcHandlers } from './ipc/index'
import { closeDb, getDb } from './storage/db'
import { seedDefaultModels } from './storage/models'
import { registerMemoryTools } from './tools/builtin/memory'
import { registerCreateTools } from './tools/builtin/create'
import { createTray, destroyTray } from './tray'
import {
  registerGlobalShortcut,
  setupNativeMenu,
  unregisterGlobalShortcut,
} from './native-menu'
import { setupAutoUpdater, stopAutoUpdater } from './updater'
import {
  clearRunning,
  hadCrashedLastRun,
  listDrafts,
  markRunning,
} from './crash-recovery'
import { logger } from './logger'

const isMac = process.platform === 'darwin'

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
    // —— 崩溃恢复（§11.5/.7）：启动检测上次崩溃 + 写哨兵 ——
    const crashed = hadCrashedLastRun()
    markRunning()
    if (crashed) {
      logger.warn('[crash] 检测到上次异常退出，草稿可恢复')
    }

    getDb() // 初始化 SQLite（WAL + 迁移 + integrity_check，§11.4）
    seedDefaultModels() // 首次启动 seed Claude Code 预置模型
    registerMemoryTools() // 内置记忆工具（L3 recall/search/retain）
    registerCreateTools() // 聊天创建工具（propose_*，不落库，确认才入库）
    registerIpcHandlers()
    createMainWindow()

    // 上次崩溃 → 推渲染层提示恢复草稿
    if (crashed) {
      const win = BrowserWindow.getAllWindows()[0]
      win?.webContents.once('did-finish-load', () =>
        win.webContents.send('app:crashRecovery', { drafts: listDrafts() }),
      )
    }

    // —— 原生能力（§六）——
    // 测试环境（NODE_ENV=test）跳过托盘/菜单/快捷键（无显示环境会抛错卡住）
    const isTest = process.env.NODE_ENV === 'test'
    if (!isTest) {
      try {
        setupNativeMenu(getMainWindow)
        createTray(getMainWindow)
        registerGlobalShortcut(getMainWindow)
      } catch (error) {
        logger.warn('[main] 原生能力初始化失败（可能无显示环境）', error)
      }
      setupAutoUpdater(getMainWindow)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow()
      }
    })
  })

  function getMainWindow(): BrowserWindow | null {
    return BrowserWindow.getAllWindows()[0] ?? null
  }

  app.on('window-all-closed', () => {
    if (!isMac) {
      app.quit()
    }
  })

  // —— 退出前关闭 DB 连接 + 清理托盘/快捷键，防写一半断电 ——
  app.on('before-quit', () => {
    clearRunning()
    unregisterGlobalShortcut()
    destroyTray()
    stopAutoUpdater()
    closeDb()
  })
}
