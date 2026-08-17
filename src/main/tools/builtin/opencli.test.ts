import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { clearTools, executeTool, listToolDefs } from '../registry'
import { registerOpenCliTools, resolveOpenCli } from './opencli'

// —— opencli_run 单测（mock spawn，验证白名单/写拦截/退出码映射/随包解析）——

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
import { spawn } from 'node:child_process'

const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>

/** 造一个假 child：按计划吐 stdout 后 close；或 error 事件 */
function fakeChild(plan: { stdout?: string; stderr?: string; code?: number; error?: Error }) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  queueMicrotask(() => {
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

describe('tools/builtin/opencli', () => {
  beforeEach(() => {
    clearTools()
    registerOpenCliTools()
    spawnMock.mockReset()
  })

  it('opencli_run 注册进清单', () => {
    expect(listToolDefs().map((t) => t.name)).toContain('opencli_run')
  })

  it('写操作动词直接拦截，不发起 spawn', async () => {
    const r = await executeTool(
      'opencli_run',
      { args: ['xiaohongshu', 'publish', 'title'] },
      'tu_1',
      {},
    )
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(false)
    expect(data.error).toBe('write_op_blocked')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('读取命令成功：透传参数并返回输出', async () => {
    spawnMock.mockReturnValue(fakeChild({ stdout: '{"notes":[]}', code: 0 }))
    const r = await executeTool(
      'opencli_run',
      { args: ['xiaohongshu', 'search', 'AI', '--limit', '5', '-f', 'json'] },
      'tu_2',
      {},
    )
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(true)
    expect(data.output).toContain('notes')
    // 回退系统 PATH（测试环境无随包 resources）
    expect(spawnMock).toHaveBeenCalledWith(
      'opencli',
      ['xiaohongshu', 'search', 'AI', '--limit', '5', '-f', 'json'],
      expect.objectContaining({ env: expect.anything() }),
    )
  })

  it('exit 69（Browser Bridge 未连接）→ 指向 Chrome 扩展的提示', async () => {
    spawnMock.mockReturnValue(fakeChild({ code: 69, stderr: 'bridge down' }))
    const r = await executeTool('opencli_run', { args: ['zhihu', 'hot'] }, 'tu_3', {})
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(false)
    expect(data.error).toBe('exit_69')
    expect(data.hint).toContain('Chrome')
  })

  it('spawn ENOENT（未安装）→ opencli_not_found 引导安装', async () => {
    spawnMock.mockReturnValue(fakeChild({ error: new Error('spawn opencli ENOENT') }))
    const r = await executeTool('opencli_run', { args: ['list'] }, 'tu_4', {})
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(false)
    expect(data.error).toBe('opencli_not_found')
  })

  it('stdout 超上限：SIGKILL 子进程 + 结构化错误（防内存无界累积）', async () => {
    spawnMock.mockReturnValue(fakeChild({ stdout: 'x'.repeat(300 * 1024), code: 0 }))
    const r = await executeTool('opencli_run', { args: ['zhihu', 'hot'] }, 'tu_5', {})
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(false)
    expect(data.error).toBe('stdout_limit_exceeded')
    const child = spawnMock.mock.results[0].value as { kill: ReturnType<typeof vi.fn> }
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('(site,verb) 元组级 access：同一动词 read 站点放行、write 站点拒绝', async () => {
    // bilibili/download 在 manifest 标 read → 放行
    spawnMock.mockReturnValue(fakeChild({ stdout: '{"url":"x"}', code: 0 }))
    const rOk = await executeTool('opencli_run', { args: ['bilibili', 'download', 'video-1'] }, 'tu_6', {})
    const dOk = JSON.parse(rOk.content)
    expect(dOk.ok).toBe(true)

    // suno/download 在 manifest 标 write → 拦截
    const rBlock = await executeTool('opencli_run', { args: ['suno', 'download', 'song-1'] }, 'tu_7', {})
    const dBlock = JSON.parse(rBlock.content)
    expect(dBlock.ok).toBe(false)
    expect(dBlock.error).toBe('write_op_blocked')
    expect(spawnMock).not.toHaveBeenCalledWith(
      'opencli',
      expect.arrayContaining(['suno', 'download']),
      expect.anything(),
    )
  })

  it('未知 (site,verb) 元组 → fail-closed 拒绝（防新动词绕过）', async () => {
    // 一个 manifest 不存在的 site+verb 组合：应被拒（白名单语义，默认拒绝）
    const r = await executeTool('opencli_run', { args: ['fakesite_xyz', 'fakeread'] }, 'tu_8', {})
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(false)
    expect(data.error).toBe('write_op_blocked')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('全局只读命令 list/help/version 放行（无 site/verb 配对）', async () => {
    spawnMock.mockReturnValue(fakeChild({ stdout: '{"sites":[]}', code: 0 }))
    const r = await executeTool('opencli_run', { args: ['list'] }, 'tu_9', {})
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(true)
  })
})

describe('resolveOpenCli 随包解析', () => {
  it('resources 下存在 vendor 包 → 用 ELECTRON_RUN_AS_NODE 跑主二进制', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'one-res-'))
    const cliDir = path.join(root, 'opencli', 'node_modules', '@jackwener', 'opencli', 'dist', 'src')
    mkdirSync(cliDir, { recursive: true })
    writeFileSync(path.join(cliDir, 'main.js'), '// stub')
    const target = resolveOpenCli(root)
    expect(target.cmd).toBe(process.execPath)
    expect(target.argsPrefix[0]).toContain('@jackwener')
    expect(target.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('无 vendor 包（开发环境）→ 回退系统 PATH opencli', () => {
    const target = resolveOpenCli('/nonexistent/resources')
    expect(target.cmd).toBe('opencli')
    expect(target.argsPrefix).toEqual([])
  })
})
