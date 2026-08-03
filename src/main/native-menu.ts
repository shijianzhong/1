import { app, BrowserWindow, Menu, globalShortcut, shell } from 'electron'
import { logger } from './logger'

// —— 原生菜单 + 全局快捷键（§六）——

const ACCELERATOR_SHOW = 'CommandOrControl+Shift+E'

export function setupNativeMenu(getMainWindow: () => BrowserWindow | null): void {
  const template: Array<Electron.MenuItemConstructorOptions> = [
    {
      label: '文件',
      submenu: [
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重载' },
        { role: 'forceReload', label: '强制重载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 One',
          click: () => getMainWindow()?.webContents.send('app:navigate', '/settings'),
        },
        {
          label: '打开仓库',
          click: () => void shell.openExternal('https://github.com/shijianzhong/1'),
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

export function registerGlobalShortcut(getMainWindow: () => BrowserWindow | null): void {
  const ret = globalShortcut.register(ACCELERATOR_SHOW, () => {
    const win = getMainWindow()
    if (!win) return
    if (win.isVisible() && win.isFocused()) {
      win.hide()
    } else {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    logger.info('[shortcut] 唤起窗口')
  })
  if (!ret) logger.warn(`[shortcut] 注册失败：${ACCELERATOR_SHOW}`)
}

export function unregisterGlobalShortcut(): void {
  globalShortcut.unregister(ACCELERATOR_SHOW)
}
