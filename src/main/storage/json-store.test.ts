import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJsonFile, writeTextFile, readJsonFile } from './json-store'

const dir = mkdtempSync(join(tmpdir(), 'json-store-test-'))

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('writeTextFile（原子写盘 §11.4）', () => {
  it('写入内容可被原样读出', () => {
    const p = join(dir, 'handler.js')
    writeTextFile(p, "return await ctx.executeTool('file_read', { path: '/x' })")
    expect(readFileSync(p, 'utf8')).toBe(
      "return await ctx.executeTool('file_read', { path: '/x' })",
    )
  })

  it('写盘后不残留 .tmp 临时文件', () => {
    const p = join(dir, 'nested', 'sub', 'handler.js')
    writeTextFile(p, 'hello')
    expect(existsSync(p)).toBe(true)
    // 临时文件形如 <path>.<pid>.<hex>.tmp，写完后应被 rename 掉
    const parent = join(p, '..')
    const leftovers = require('node:fs')
      .readdirSync(parent)
      .filter((f: string) => f.includes('.tmp'))
    expect(leftovers).toHaveLength(0)
  })

  it('与 writeJsonFile 同目录共存不互踩', () => {
    writeTextFile(join(dir, 'a.js'), 'x')
    writeJsonFile(join(dir, 'a.json'), { ok: true })
    expect(readFileSync(join(dir, 'a.js'), 'utf8')).toBe('x')
    expect(readJsonFile(join(dir, 'a.json'), null)).toEqual({ ok: true })
  })
})
