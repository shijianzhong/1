import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// —— worker-client.ts 单测（mock spawn 假子进程 + mock killProcessGroup）——
// 关键覆盖（review #22/#23）：
//  1. 批超时 → 杀卡死 worker + 置 failed → 下批重建新进程（卡死自愈）
//  2. 正常完成 / 超时都移除调用方 signal 上的 abort 监听（不逐批累积）

const killMock = vi.fn()
vi.mock('../tools/processKill', () => ({
  killProcessGroup: (child: unknown) => killMock(child),
}))
vi.mock('../storage/paths', () => ({
  getKbModelDir: () => '/tmp/kb-models',
  getKbWorkerModulesDir: () => '',
  getKbWorkerScriptPath: () => '/tmp/worker-embed.cjs',
}))

class FakeStream extends EventEmitter {
  setEncoding = vi.fn()
}

class FakeChild extends EventEmitter {
  stdout = new FakeStream()
  stderr = new FakeStream()
  stdin = { write: vi.fn(), end: vi.fn() }
}

let lastChild: FakeChild | null = null
const spawnMock = vi.fn((..._args: unknown[]) => {
  lastChild = new FakeChild()
  return lastChild
})
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}))

const { embedBatchViaWorker, terminateEmbedWorker } = await import('./worker-client')

/** 从 stdin.write 的 JSON 行取 batch id，并模拟 worker 回包 */
function respondLast(vectors: (number[] | null)[]): void {
  const line = lastChild!.stdin.write.mock.calls.at(-1)![0] as string
  const req = JSON.parse(line) as { id: string }
  lastChild!.stdout.emit('data', JSON.stringify({ id: req.id, vectors }) + '\n')
}

beforeEach(() => {
  killMock.mockClear()
  spawnMock.mockClear()
  lastChild = null
  terminateEmbedWorker() // 重置模块级 worker 单例
})

afterEach(() => {
  vi.useRealTimers()
})

describe('embedBatchViaWorker — 卡死自愈（review #22）', () => {
  it('批超时 → killProcessGroup + 下批 respawn 新 worker', async () => {
    vi.useFakeTimers()
    // 第一批：worker 永不响应（卡死）
    const p1 = embedBatchViaWorker(['hello'])
    expect(spawnMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(120_000)
    // 超时降级全 null（不抛）
    await expect(p1).resolves.toEqual([null])
    // 卡死 worker 被杀（而非留着复用）
    expect(killMock).toHaveBeenCalledTimes(1)

    // 模拟 close 事件（kill 后进程退出）→ worker 单例清空
    const killed = lastChild
    killed!.emit('close', 143)

    // 第二批：应 spawn 新 worker 而不是复用卡死进程
    const p2 = embedBatchViaWorker(['world'])
    expect(spawnMock).toHaveBeenCalledTimes(2)
    respondLast([[0.1, 0.2]])
    await expect(p2).resolves.toEqual([Float32Array.from([0.1, 0.2])])
  })
})

describe('embedBatchViaWorker — abort 监听清理（review #23）', () => {
  it('正常完成后从调用方 signal 移除 abort 监听', async () => {
    const ctrl = new AbortController()
    const removeSpy = vi.spyOn(ctrl.signal, 'removeEventListener')
    const p = embedBatchViaWorker(['a'], ctrl.signal)
    respondLast([[1, 0]])
    await expect(p).resolves.toEqual([Float32Array.from([1, 0])])
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('超时路径同样移除 abort 监听', async () => {
    vi.useFakeTimers()
    const ctrl = new AbortController()
    const removeSpy = vi.spyOn(ctrl.signal, 'removeEventListener')
    const p = embedBatchViaWorker(['a'], ctrl.signal)
    await vi.advanceTimersByTimeAsync(120_000)
    await expect(p).resolves.toEqual([null])
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('调用方 abort → 该批降级 null 且 worker 不被误杀', async () => {
    const ctrl = new AbortController()
    const p = embedBatchViaWorker(['a'], ctrl.signal)
    ctrl.abort()
    await expect(p).resolves.toEqual([null])
    // abort 是调用方主动取消，不是 worker 卡死——不杀进程
    expect(killMock).not.toHaveBeenCalled()
  })
})
