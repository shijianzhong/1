import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { getDraftsDir } from './storage/paths'
import { logger } from './logger'

// —— 崩溃恢复（§11.5 + §11.7）——
// .running 哨兵文件：正常退出删，启动时存在=上次崩溃 → 提示恢复草稿。
// crashReporter + electron-log 落盘。

const SENTINEL_FILE = '.running'

function getSentinelPath(): string {
  return `${getDraftsDir()}/../${SENTINEL_FILE}`
}

/** 写哨兵文件（app.ready 时调用，标记本次运行中） */
export function markRunning(): void {
  try {
    writeFileSync(getSentinelPath(), String(Date.now()), 'utf8')
  } catch {
    // drafts 目录可能未创建
    logger.warn('[crash] 哨兵文件写入失败')
  }
}

/** 清哨兵文件（正常退出时调用） */
export function clearRunning(): void {
  try {
    rmSync(getSentinelPath())
  } catch {
    // 静默
  }
}

/**
 * 启动时检查哨兵：存在=上次异常退出 → 返回 true 供渲染层提示恢复草稿。
 */
export function hadCrashedLastRun(): boolean {
  return existsSync(getSentinelPath())
}

/**
 * 列出草稿文件（§11.7）：编排画布/聊天未发送输入/设置未保存改动。
 * debounce 落盘 userData/drafts/。
 */
export function listDrafts(): Array<{ name: string; content: string }> {
  const dir = getDraftsDir()
  if (!existsSync(dir)) return []
  const { readdirSync, readFileSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return { name: f, content: readFileSync(join(dir, f), 'utf8') }
      } catch {
        return null
      }
    })
    .filter((v): v is { name: string; content: string } => v !== null)
}

/** 删除草稿 */
export function removeDraft(name: string): void {
  try {
    rmSync(`${getDraftsDir()}/${name}`)
  } catch {
    // 静默
  }
}
