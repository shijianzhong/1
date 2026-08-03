import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { Skill } from '@shared/types'
import { clearTools, executeTool, listToolDefs } from '../registry'
import { registerSkillScriptTools } from './skillScript'

// —— skill_run_script 单测（铁律23：async spawn + 路径安全）——
// spawn 走 mock；技能清单 mock storage/models（避免 SQLite 依赖）；脚本用真实临时目录。

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('../../storage/models', () => ({
  listSkills: vi.fn(() => []),
}))

import { spawn } from 'node:child_process'
import { listSkills } from '../../storage/models'

const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>
const listSkillsMock = listSkills as unknown as ReturnType<typeof vi.fn>

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

/** 造真实技能目录：skl_x/scripts/analyze.py */
function makeSkillDir(): { skill: Skill } {
  const root = mkdtempSync(path.join(tmpdir(), 'one-skill-script-'))
  const scriptsDir = path.join(root, 'scripts')
  mkdirSync(scriptsDir, { recursive: true })
  writeFileSync(path.join(scriptsDir, 'analyze.py'), 'print("hi")')
  return {
    skill: {
      id: 'skl_x',
      name: '调研',
      content: '# 内容',
      scriptPath: path.join(scriptsDir, 'analyze.py'),
      createdAt: 0,
      updatedAt: 0,
    },
  }
}

describe('tools/builtin/skillScript', () => {
  beforeEach(() => {
    clearTools()
    registerSkillScriptTools()
    spawnMock.mockReset()
    listSkillsMock.mockReset()
  })

  it('skill_run_script 注册进清单', () => {
    expect(listToolDefs().map((t) => t.name)).toContain('skill_run_script')
  })

  it('技能不存在 → skill_not_found，不发起 spawn', async () => {
    listSkillsMock.mockReturnValue([])
    const r = await executeTool('skill_run_script', { skill: '不存在', script: 'a.py' }, 'tu_1', {})
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(false)
    expect(data.error).toBe('skill_not_found')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('路径穿越 ../ 拒绝', async () => {
    const { skill } = makeSkillDir()
    listSkillsMock.mockReturnValue([skill])
    const r = await executeTool(
      'skill_run_script',
      { skill: '调研', script: '../escape.sh' },
      'tu_2',
      {},
    )
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(false)
    expect(data.error).toBe('invalid_script_path')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('脚本不存在 → script_not_found，hint 列可用脚本', async () => {
    const { skill } = makeSkillDir()
    listSkillsMock.mockReturnValue([skill])
    const r = await executeTool('skill_run_script', { skill: '调研', script: 'ghost.py' }, 'tu_3', {})
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(false)
    expect(data.error).toBe('script_not_found')
    expect(data.hint).toContain('analyze.py')
  })

  it('成功执行：python3 解释器 + cwd=技能根目录 + 透传参数', async () => {
    const { skill } = makeSkillDir()
    listSkillsMock.mockReturnValue([skill])
    spawnMock.mockReturnValue(fakeChild({ stdout: '{"rows":3}', code: 0 }))
    const r = await executeTool(
      'skill_run_script',
      { skill: '调研', script: 'analyze.py', args: ['--limit', '3'] },
      'tu_4',
      {},
    )
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(true)
    expect(data.output).toContain('rows')
    const [cmd, argv, opts] = spawnMock.mock.calls[0] as [string, string[], { cwd: string }]
    expect(cmd).toBe('python3')
    expect(argv[0]).toBe(skill.scriptPath)
    expect(argv.slice(1)).toEqual(['--limit', '3'])
    expect(opts.cwd).toBe(path.dirname(path.dirname(skill.scriptPath!)))
  })

  it('非零退出 → 结构化错误 + stderr 摘要', async () => {
    const { skill } = makeSkillDir()
    listSkillsMock.mockReturnValue([skill])
    spawnMock.mockReturnValue(fakeChild({ stderr: 'boom', code: 2 }))
    const r = await executeTool('skill_run_script', { skill: '调研', script: 'analyze.py' }, 'tu_5', {})
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(false)
    expect(data.error).toBe('exit_2')
    expect(data.stderr).toContain('boom')
  })

  it('解释器缺失（ENOENT）→ interpreter_not_found', async () => {
    const { skill } = makeSkillDir()
    listSkillsMock.mockReturnValue([skill])
    spawnMock.mockReturnValue(fakeChild({ error: new Error('spawn python3 ENOENT') }))
    const r = await executeTool('skill_run_script', { skill: '调研', script: 'analyze.py' }, 'tu_6', {})
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(false)
    expect(data.error).toBe('interpreter_not_found')
  })

  it('不支持的脚本类型 → unsupported_script_type', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'one-skill-script-'))
    const scriptsDir = path.join(root, 'scripts')
    mkdirSync(scriptsDir, { recursive: true })
    writeFileSync(path.join(scriptsDir, 'data.bin'), 'x')
    const skill: Skill = {
      id: 'skl_y',
      name: '二进制技能',
      content: '',
      scriptPath: path.join(scriptsDir, 'data.bin'),
      createdAt: 0,
      updatedAt: 0,
    }
    listSkillsMock.mockReturnValue([skill])
    const r = await executeTool('skill_run_script', { skill: 'skl_y', script: 'data.bin' }, 'tu_7', {})
    const data = JSON.parse(r.content)
    expect(data.ok).toBe(false)
    expect(data.error).toBe('unsupported_script_type')
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
