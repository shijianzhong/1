import { join } from 'node:path'
import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import { logger } from './logger'

// —— 系统托盘（§六）——
// 右键菜单：显示/设置/退出。常驻。

let tray: Tray | null = null

export function createTray(getMainWindow: () => BrowserWindow | null): Tray {
  // 托盘图标：mac 用 trayTemplate.png（单色+alpha，setTemplateImage 让系统按菜单栏明暗
  // 自动反色）；win/linux 用 trayColor.png（带色 32x32）。
  // 打包后经 extraResources 复制到 process.resourcesPath；开发环境从 build/icons 读。
  const isMac = process.platform === 'darwin'
  const iconName = isMac ? 'trayTemplate.png' : 'trayColor.png'
  let icon = nativeImage.createEmpty()
  try {
    const iconPath = app.isPackaged
      ? join(process.resourcesPath, iconName)
      : join(__dirname, '../../build/icons', isMac ? 'trayTemplate.png' : 'tray.png')
    icon = nativeImage.createFromPath(iconPath)
    if (icon.isEmpty()) {
      icon = nativeImage.createEmpty()
    } else if (isMac) {
      icon = icon.resize({ width: 22, height: 22 })
      icon.setTemplateImage(true)
    }
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
