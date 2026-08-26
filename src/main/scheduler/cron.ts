// —— cron 解析封装（§定时任务）——
// 纯函数已下沉至 @shared/cron，主进程与渲染层共用，避免漂移（#13）。
// 此文件保留 re-export 以兼容既有 import 路径（engine/scheduler/ipc 与单测）。
export {
  validateCron,
  nextOccurrence,
  previewNextRun,
  hasUpcomingOccurrence,
  isValidTimeZone,
  formatLocal,
  type CronValidationResult,
} from '@shared/cron'
