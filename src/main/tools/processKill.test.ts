import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { killProcessGroup } from './processKill'

// —— processKill 辅助单测（P1-6：子进程组终止，防孙进程孤儿）——

describe('tools/processKill killProcessGroup', () => {
  const realKill = process.kill
  let killSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    killSpy = vi.fn()
    // @ts-expect-error mock process.kill（读全局 process）
    process.kill = killSpy
  })
  afterEach(() => {
    process.kill = realKill
  })

  /** 造一个带 pid 的假 child（仅含 killProcessGroup 需要的字段） */
  function fakeChild(pid?: number): ChildProcess {
    return { pid, kill: vi.fn() } as unknown as ChildProcess
  }

  it('有 pid → 向进程组（负 pid）发信号 + 兜底 child.kill', () => {
    const childKill = vi.fn()
    const child = { pid: 12345, kill: childKill } as unknown as ChildProcess

    killProcessGroup(child, 'SIGKILL')

    // 进程组信号：负 pid = -12345
    expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGKILL')
    // 兜底也调用
    expect(childKill).toHaveBeenCalledWith('SIGKILL')
  })

  it('无 pid（子进程尚未 spawn 成功）→ 不调 process.kill，仅 child.kill', () => {
    const childKill = vi.fn()
    const child = { pid: undefined, kill: childKill } as unknown as ChildProcess

    killProcessGroup(child)

    expect(killSpy).not.toHaveBeenCalled()
    expect(childKill).toHaveBeenCalled()
  })

  it('进程组信号 ESRCH（进程已退出）→ 静默忽略，仍兜底 child.kill', () => {
    const childKill = vi.fn()
    const child = { pid: 999, kill: childKill } as unknown as ChildProcess
    killSpy.mockImplementation(() => {
      const e = new Error('') as NodeJS.ErrnoException
      e.code = 'ESRCH'
      throw e
    })

    expect(() => killProcessGroup(child)).not.toThrow()
    expect(killSpy).toHaveBeenCalledWith(-999, 'SIGKILL')
    expect(childKill).toHaveBeenCalledWith('SIGKILL')
  })

  it('进程组信号 EPERM（跨用户进程）→ 降级，不抛，仍兜底 child.kill', () => {
    const childKill = vi.fn()
    const child = { pid: 888, kill: childKill } as unknown as ChildProcess
    killSpy.mockImplementation(() => {
      const e = new Error('') as NodeJS.ErrnoException
      e.code = 'EPERM'
      throw e
    })

    expect(() => killProcessGroup(child)).not.toThrow()
    expect(childKill).toHaveBeenCalledWith('SIGKILL')
  })

  it('进程组信号其他 errno（如 Windows EINVAL）→ 不抛，降级 warn + 兜底 child.kill', () => {
    const childKill = vi.fn()
    const child = { pid: 777, kill: childKill } as unknown as ChildProcess
    killSpy.mockImplementation(() => {
      const e = new Error('invalid') as NodeJS.ErrnoException
      e.code = 'EINVAL'
      throw e
    })

    // 超时/abort 路径绝不能因杀进程抛出新异常
    expect(() => killProcessGroup(child)).not.toThrow()
    expect(childKill).toHaveBeenCalledWith('SIGKILL')
  })

  it('默认信号为 SIGKILL', () => {
    const child = { pid: 1, kill: vi.fn() } as unknown as ChildProcess
    killProcessGroup(child)
    expect(killSpy).toHaveBeenCalledWith(-1, 'SIGKILL')
  })

  it('可指定其他信号（如 SIGTERM 优雅终止）', () => {
    const child = { pid: 5, kill: vi.fn() } as unknown as ChildProcess
    killProcessGroup(child, 'SIGTERM')
    expect(killSpy).toHaveBeenCalledWith(-5, 'SIGTERM')
  })
})
