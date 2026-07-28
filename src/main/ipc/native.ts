import { app, nativeTheme, Notification, type BrowserWindow } from 'electron'
import { withHandler } from './handler'

// —— 原生能力 IPC（§六）——
// 通知 + 开机自启 + nativeTheme 明暗跟随。

export function registerNativeHandlers(getMainWindow: () => BrowserWindow | null): void {
  // —— 开机自启 ——
  withHandler<boolean>('app:setAutoLaunch', (_e, onRaw) => {
    const on = onRaw as boolean
    app.setLoginItemSettings({
      openAtLogin: on,
      openAsHidden: false,
    })
    return app.getLoginItemSettings().openAtLogin
  })

  withHandler<boolean>('app:getAutoLaunch', () => app.getLoginItemSettings().openAtLogin)

  // —— 通知（任务完成提醒，§六）——
  withHandler<void>('app:notify', (_e, inputRaw) => {
    const input = inputRaw as { title: string; body: string }
    if (Notification.isSupported()) {
      new Notification({ title: input.title, body: input.body }).show()
    }
    return undefined
  })

  // —— nativeTheme 明暗跟随：渲染层订阅系统主题变化 ——
  // 渲染层已用 matchMedia 监听；这里额外暴露主动查询
  withHandler<'light' | 'dark' | 'system'>('app:getSystemColorMode', () => {
    if (nativeTheme.shouldUseDarkColors) return 'dark'
    return 'light'
  })

  // 主进程监听系统主题变化，推送给渲染层（与渲染层 matchMedia 互为兜底）
  nativeTheme.on('updated', () => {
    const win = getMainWindow()
    win?.webContents.send('app:systemColorModeChanged', nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  })

  // —— 显示/隐藏窗口（托盘/快捷键外部调用）——
  withHandler<void>('app:show', () => {
    const win = getMainWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
}
