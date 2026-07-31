// 必须在所有 storage/ipc 模块 import 之前执行：ONE_USER_DATA env 覆盖 userData 目录。
// ESM/CJS import 提升——storage 模块顶层即 new JsonCollection(getCapabilitiesDir())，
// 若 setPath 在 import 后才执行，JSON store 会用默认 userData 初始化（测试隔离失效）。
import { app } from 'electron'

if (process.env.ONE_USER_DATA) {
  app.setPath('userData', process.env.ONE_USER_DATA)
}
