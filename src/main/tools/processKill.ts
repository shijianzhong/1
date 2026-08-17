import type { ChildProcess } from 'node:child_process'
import { logger } from '../logger'

// —— 子进程组终止辅助（§11 / CODE_AUDIT P1-6）——
// opencli / skill_run_script 的子进程会再 spawn 自己的子进程（opencli 起 Chrome、
// Python 脚本 subprocess/shell out）。child.kill('SIGKILL') 只杀直接子进程，
// 孙进程脱离父管成为孤儿继续跑（超时/abort 后仍在耗 CPU/占浏览器会话）。
//
// 解法：spawn 时设 detached:true → 子进程成为新进程组组长，其 pid 即为 pgid；
// 终止时 process.kill(-pid, sig) 向整个进程组发信号，连带孙进程一并杀掉。
// child.kill() 仍调（清理 ChildProcess 对象内部状态），负 pid 调用做兜底。

/**
 * 杀掉子进程及其整个进程组（连同孙进程）。
 * 调用方需在 spawn 时传 detached:true 使子进程成为新进程组组长。
 * 信号默认 SIGKILL（不可拦截，确保超时/abort 一定停）。
 */
export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  const pid = child.pid
  if (typeof pid === 'number') {
    // 先向整个进程组发信号（负 pid = pgid）。ESRCH=进程已退出，属正常幂等。
    try {
      process.kill(-pid, signal)
    } catch (e) {
      // 负 pid 进程组信号是 POSIX 语义：Windows 无此概念，kill(-pid) 可能抛 EINVAL 等
      // 非预期错误码。此处绝不能 rethrow——调用方在超时/abort 路径上，rethrow 会把
      // 「杀进程」变成新异常源。任何失败一律降级为 warn + 只杀直接子进程（下方兜底）。
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ESRCH' && code !== 'EPERM') {
        logger.warn(`[processKill] 进程组信号失败（pid=${pid}, code=${code ?? 'unknown'}），降级只杀直接子进程`, e)
      }
    }
  }
  // 兜底：清理 ChildProcess 内部句柄（即使上面已发信号）
  try {
    child.kill(signal)
  } catch {
    // 子进程已退出 → kill 抛 ESRCH，忽略
  }
}
