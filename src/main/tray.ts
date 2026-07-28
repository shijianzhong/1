import { join } from 'node:path'
import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import { logger } from './logger'

// —— 系统托盘（§六）——
// 右键菜单：显示/设置/退出。常驻。

let tray: Tray | null = null

export function createTray(getMainWindow: () => BrowserWindow | null): Tray {
  // 托盘图标：用 nativeImage 创建空 1x1（无图标资源时）；后续替换为 resources/tray.png
  let icon = nativeImage.createEmpty()
  try {
    const iconPath = join(__dirname, '../../resources/tray.png')
    icon = nativeImage.createFromPath(iconPath)
    if (icon.isEmpty()) icon = nativeImage.createEmpty()
  } catch {
    // 资源缺失用空图
  }

  tray = new Tray(icon)
  const menu = Menu.buildFromTemplate([
    {
      label: '显示',
      click: () => {
        const win = getMainWindow()
        if (win) {
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
        }
      },
    },
    {
      label: '设置',
      click: () => {
        const win = getMainWindow()
        if (win) {
          win.show()
          win.focus()
          win.webContents.send('app:navigate', '/settings')
        }
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => app.quit(),
    },
  ])

  tray.setToolTip('One')
  tray.setContextMenu(menu)
  tray.on('click', () => {
    const win = getMainWindow()
    if (win) {
      if (win.isVisible()) win.hide()
      else win.show()
    }
  })

  logger.info('[tray] 托盘已创建')
  return tray
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
}
