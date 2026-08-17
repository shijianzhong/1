import type { ChildProcess } from 'node:child_process'

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
      // EPERM：不是本用户进程（极少见，跨用户 spawn）→ 降级只杀直接子进程
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH' && (e as NodeJS.ErrnoException).code !== 'EPERM') {
        throw e
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
