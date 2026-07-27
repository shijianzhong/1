import { app } from 'electron'
import log from 'electron-log'

// —— 日志落盘到 userData/logs/main.log（§11.5）——
// app.getPath 在 ready 前不可用，用 try/catch 兜底到默认路径。
log.transports.file.level = 'info'
log.transports.file.resolvePathFn = () => {
  try {
    return `${app.getPath('userData')}/logs/main.log`
  } catch {
    return `${process.cwd()}/logs/main.log`
  }
}
log.transports.console.level = 'info'

export const logger = log
