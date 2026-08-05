import { EventEmitter } from 'node:events'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { clearTools, executeTool, listToolDefs } from '../registry'
import { registerShellTools } from './shell'

// —— shell_run 单测（mock spawn，验证 DANGER_PATTERNS 拦截 / 审批闸门 / 退出码 / 超时 / stdout 限制）——

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
import { spawn } from 'node:child_process'

const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>

/** 造一个假 child：按计划吐 stdout 后 close；或 error 事件 */
function fakeChild(plan: {
  stdout?: string
  stderr?: string
  code?: number
  error?: Error
  pid?: number
}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
    pid: number
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  child.pid = plan.pid ?? 12345
  setTimeout(() => {
    if (plan.error) {
      child.emit('error', plan.error)
      return
    }
    if (plan.stdout) child.stdout.emit('data', Buffer.from(plan.stdout))
    if (plan.stderr) child.stderr.emit('data', Buffer.from(plan.stderr))
    child.emit('close', plan.code ?? 0)
  })
  return child
}

describe('tools/builtin/shell', () => {
  beforeEach(() => {
    clearTools()
    registerShellTools()
    spawnMock.mockReset()
  })

  it('shell_run 注册进清单', () => {
    expect(listToolDefs().map((t) => t.name)).toContain('shell_run')
  })

  it('DANGER_PATTERNS：rm -rf / 在审批前被硬拦截（不 spawn）', async () => {
    const r = await executeTool(
      'shell_run',
      { command: 'rm -rf /' },
      'tu_1',
      { onApprove: vi.fn().mockResolvedValue({ approved: true }) },
    )
    const data = JSON.parse(r.content)
    expect(r.isError).toBe(true)
    expect(data.error).toBe('dangerous_command_blocked')
    expect(data.messageKey).toBe('errors.tools.shell_danger_command')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('DANGER_PATTERNS：mkfs 在审批前被硬拦截', async () => {
    const r = await executeTool(
      'shell_run',
      { command: 'mkfs.ext4 /dev/sda1' },
      'tu_2',
      { onApprove: vi.fn().mockResolvedValue({ approved: true }) },
    )
    const data = JSON.parse(r.content)
    expect(r.isError).toBe(true)
    expect(data.error).toBe('dangerous_command_blocked')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('DANGER_PATTERNS：shutdown 在审批前被硬拦截', async () => {
    const r = await executeTool(
      'shell_run',
      { command: 'shutdown -h now' },
      'tu_3',
      { onApprove: vi.fn().mockResolvedValue({ approved: true }) },
    )
    expect(r.isError).toBe(true)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('approvalMode=always + 无 onApprove → approval_unavailable', async () => {
    const r = await executeTool('shell_run', { command: 'echo hi' }, 'tu_4', {})
    const data = JSON.parse(r.content)
    expect(r.isError).toBe(true)
    expect(data.error).toBe('approval_unavailable')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('approvalMode=always + onApprove denied → 不执行', async () => {
    const r = await executeTool(
      'shell_run',
      { command: 'echo hi' },
      'tu_5',
      { onApprove: vi.fn().mockResolvedValue({ approved: false }) },
    )
    const data = JSON.parse(r.content)
    expect(r.isError).toBe(true)
    expect(data.error).toBe('approval_denied')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('审批通过 + 命令成功执行（exit 0）', async () => {
    spawnMock.mockReturnValue(fakeChild({ stdout: 'hello world', code: 0 }))
    const r = await executeTool(
      'shell_run',
      { command: 'echo hello world' },
      'tu_6',
      { onApprove: vi.fn().mockResolvedValue({ approved: true }) },
    )
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(true)
    expect(data.output).toBe('hello world')
    expect(data.exitCode).toBe(0)
    expect(data.truncated).toBe(false)
  })

  it('命令失败（exit 1）→ ok=false + nonzero_exit messageKey', async () => {
    spawnMock.mockReturnValue(fakeChild({ stdout: '', stderr: 'command not found', code: 1 }))
    const r = await executeTool(
      'shell_run',
      { command: 'false' },
      'tu_7',
      { onApprove: vi.fn().mockResolvedValue({ approved: true }) },
    )
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(false)
    expect(data.exitCode).toBe(1)
    expect(data.stderr).toContain('command not found')
    expect(data.messageKey).toBe('errors.tools.shell_nonzero_exit')
  })

  it('stdout 超上限 → SIGKILL + 结构化错误', async () => {
    spawnMock.mockReturnValue(fakeChild({ stdout: 'x'.repeat(300 * 1024), code: 0 }))
    const r = await executeTool(
      'shell_run',
      { command: 'cat /dev/zero' },
      'tu_8',
      { onApprove: vi.fn().mockResolvedValue({ approved: true }) },
    )
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(false)
    expect(data.error).toBe('stdout_limit_exceeded')
    expect(data.messageKey).toBe('errors.tools.shell_stdout_limit')
  })

  it('cwd 参数透传给 spawn', async () => {
    spawnMock.mockReturnValue(fakeChild({ stdout: '', code: 0 }))
    await executeTool(
      'shell_run',
      { command: 'pwd', cwd: '/tmp' },
      'tu_9',
      { onApprove: vi.fn().mockResolvedValue({ approved: true }) },
    )
    expect(spawnMock).toHaveBeenCalledWith(
      'pwd',
      expect.objectContaining({ cwd: '/tmp', shell: true }),
    )
  })

  it('timeoutSec 透传（Zod max 300 约束）', async () => {
    spawnMock.mockReturnValue(fakeChild({ stdout: '', code: 0 }))
    await executeTool(
      'shell_run',
      { command: 'sleep 1', timeoutSec: 60 },
      'tu_10',
      { onApprove: vi.fn().mockResolvedValue({ approved: true }) },
    )
    expect(spawnMock).toHaveBeenCalledWith(
      'sleep 1',
      expect.objectContaining({ shell: true }),
    )
  })

  it('timeoutSec 超过 300 → Zod 校验失败', async () => {
    const r = await executeTool(
      'shell_run',
      { command: 'echo hi', timeoutSec: 301 },
      'tu_11',
      { onApprove: vi.fn().mockResolvedValue({ approved: true }) },
    )
    expect(r.isError).toBe(true)
    expect(r.content).toContain('invalid_args')
  })

  it('审批通过后 onApprove 收到完整命令参数', async () => {
    spawnMock.mockReturnValue(fakeChild({ stdout: '', code: 0 }))
    const onApprove = vi.fn().mockResolvedValue({ approved: true })
    await executeTool(
      'shell_run',
      { command: 'npm install', cwd: '/project' },
      'tu_12',
      { onApprove },
    )
    expect(onApprove).toHaveBeenCalledWith({
      toolName: 'shell_run',
      args: { command: 'npm install', cwd: '/project' },
    })
  })

  it('spawn ENOENT → shell_not_found 错误', async () => {
    spawnMock.mockReturnValue(fakeChild({ error: new Error('spawn ENOENT') }))
    const r = await executeTool(
      'shell_run',
      { command: 'nonexistent-binary' },
      'tu_13',
      { onApprove: vi.fn().mockResolvedValue({ approved: true }) },
    )
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(false)
    expect(data.error).toBe('shell_not_found')
  })
})
