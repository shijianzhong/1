import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { getDraftsDir, getUserDataDir } from './storage/paths'
import { logger } from './logger'

// —— 崩溃恢复（§11.5 + §11.7）——
// .running 哨兵文件：正常退出删，启动时存在=上次崩溃 → 提示恢复草稿。
// crashReporter + electron-log 落盘。

const SENTINEL_FILE = '.running'

/** 哨兵放 userData 根下（不是 drafts/ 内）。
 *  旧实现用 `drafts/../.running`：内核路径遍历要求中间目录 drafts 存在，
 *  草稿 UI 未闭环时 drafts 从未创建 → 每次启动 ENOENT（日志里「哨兵文件写入失败」）。 */
function getSentinelPath(): string {
  return join(getUserDataDir(), SENTINEL_FILE)
}

/** 写哨兵文件（app.ready 时调用，标记本次运行中） */
export function markRunning(): void {
  try {
    const path = getSentinelPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, String(Date.now()), 'utf8')
  } catch (error) {
    logger.warn('[crash] 哨兵文件写入失败', error)
  }
}

/** 清哨兵文件（正常退出时调用） */
export function clearRunning(): void {
  try {
    rmSync(getSentinelPath(), { force: true })
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

/** 校验草稿文件名（仅允许 basename + .json，防路径穿越） */
function safeDraftName(name: string): string | null {
  if (typeof name !== 'string') return null
  const base = name.replace(/[/\\]/g, '')
  if (!base || base !== name || !base.endsWith('.json')) return null
  return base
}

/**
 * 写入草稿（§11.7）：编排画布 / 聊天未发送输入 debounce 落盘。
 * name 必须是 basename 且以 .json 结尾。
 */
export function writeDraft(name: string, content: string): void {
  const base = safeDraftName(name)
  if (!base) {
    logger.warn('[crash] writeDraft 拒绝非法文件名', name)
    return
  }
  try {
    const dir = getDraftsDir()
    mkdirSync(dir, { recursive: true })
    // 临时文件 + rename，防半截写
    const target = join(dir, base)
    const tmp = join(dir, `.${base}.${process.pid}.tmp`)
    writeFileSync(tmp, content, 'utf8')
    // rename 覆盖目标（同卷原子）
    renameSync(tmp, target)
  } catch (error) {
    logger.warn('[crash] writeDraft 失败', error)
  }
}

/** 删除草稿 */
export function removeDraft(name: string): void {
  try {
    const base = safeDraftName(name)
    if (!base) return
    rmSync(join(getDraftsDir(), base), { force: true })
  } catch {
    // 静默
  }
}
