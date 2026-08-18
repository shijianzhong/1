// 自动更新灰度（canary / staging）注入脚本。
//
// electron-builder 26 已移除配置项 `stagingPercentage`，无法在 electron-builder.yml 里声明。
// electron-updater 从 latest-*.yml 的【顶层】读取 `stagingPercentage` 决定按比例放量
// （见 electron-updater AppUpdater.isStagingMatch）。因此改为构建产物生成后，由本脚本
// 向 release/ 下的 latest-*.yml 注入顶层 stagingPercentage，再随产物上传 / 挂到 GitHub Release。
//
// 用法（CI 已在 build.yml 调用）：
//   node scripts/patch-staging.mjs
//   CANARY_PERCENT=100 node scripts/patch-staging.mjs   # 全量推送
//   RELEASE_DIR=dist node scripts/patch-staging.mjs
//
// 设计约束（产品标准）：
// - 找不到 latest*.yml 时 warn 并退出 0（不影响本地/异常环境），绝不中断发布。
// - CANARY_PERCENT 非法（非数字 / 越界）时退出 1，让 CI 显式失败而非静默放行。
// - 幂等：已是目标值时跳过，重复跑不产生副作用。

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { load, dump } from 'js-yaml'

const releaseDir = process.env.RELEASE_DIR ?? 'release'

const raw = process.env.CANARY_PERCENT
const percent = raw === undefined || String(raw).trim() === '' ? 25 : Number(raw)
if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
  console.error(`[patch-staging] CANARY_PERCENT 非法（需 0-100 的数字）: ${JSON.stringify(raw)}`)
  process.exit(1)
}

if (!existsSync(releaseDir)) {
  console.warn(`[patch-staging] 目录不存在，跳过: ${releaseDir}`)
  process.exit(0)
}

const files = readdirSync(releaseDir).filter((f) => /^latest.*\.yml$/.test(f))
if (files.length === 0) {
  console.warn(`[patch-staging] 在 ${releaseDir} 未找到 latest*.yml，跳过`)
  process.exit(0)
}

let patched = 0
for (const f of files) {
  const p = join(releaseDir, f)
  const doc = load(readFileSync(p, 'utf8')) ?? {}
  if (doc.stagingPercentage === percent) {
    console.log(`[patch-staging] ${f} 已是 ${percent}，跳过`)
    continue
  }
  doc.stagingPercentage = percent
  writeFileSync(p, dump(doc))
  patched++
  console.log(`[patch-staging] ${f} → stagingPercentage: ${percent}`)
}

console.log(`[patch-staging] 完成，共处理 ${patched}/${files.length} 个文件（目标 ${percent}）`)
