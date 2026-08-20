import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getVersion: () => '0.0.0', name: 'One' },
  BrowserWindow: class {},
}))
// 仅测 isFullBuild 纯函数，无需真实 autoUpdater；mock 掉以避免其加载时 require('electron') 在 node 环境崩溃。
vi.mock('electron-updater', () => ({
  default: { autoUpdater: {} },
}))
vi.mock('./storage/paths', () => ({
  getBuiltinKbModelDir: vi.fn(),
}))

import { app } from 'electron'
import { getBuiltinKbModelDir } from './storage/paths'
import { isBenignNoReleaseError } from './updater-errors'
import { isFullBuild } from './updater'

// electron 类型里 app.isPackaged 为只读，但测试需要控制它；运行时 mock 对象是普通对象可赋值，仅 TS 需 cast。
const setPackaged = (v: boolean): void => {
  ;(app as unknown as { isPackaged: boolean }).isPackaged = v
}

describe('isBenignNoReleaseError', () => {
  it('识别 electron-updater 无生产 release 的典型文案', () => {
    expect(
      isBenignNoReleaseError(
        new Error(
          'Cannot parse releases feed: Error: Unable to find latest version on GitHub (https://github.com/shijianzhong/1/releases/latest), please ensure a production release exists: HttpError: 406',
        ),
      ),
    ).toBe(true)
  })

  it('识别裸 Unable to find latest version', () => {
    expect(isBenignNoReleaseError(new Error('Unable to find latest version on GitHub'))).toBe(
      true,
    )
  })

  it('网络/鉴权错误不算 benign', () => {
    expect(isBenignNoReleaseError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe(false)
    expect(isBenignNoReleaseError(new Error('HttpError: 401 Unauthorized'))).toBe(false)
    expect(isBenignNoReleaseError(new Error('HttpError: 403 rate limit'))).toBe(false)
  })

  it('容错非 Error 入参', () => {
    expect(isBenignNoReleaseError('Unable to find latest version')).toBe(true)
    expect(isBenignNoReleaseError(null)).toBe(false)
  })
})

describe('isFullBuild (full 自动更新通道判定)', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'one-upd-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    vi.mocked(getBuiltinKbModelDir).mockReset()
    setPackaged(false)
  })

  it('开发/未打包环境 → false（即便存在 kb-models）', () => {
    setPackaged(false)
    mkdirSync(join(tmp, 'kb-models'), { recursive: true })
    vi.mocked(getBuiltinKbModelDir).mockReturnValue(join(tmp, 'kb-models'))
    expect(isFullBuild()).toBe(false)
  })

  it('打包 + 含 kb-models（full 包）→ true', () => {
    setPackaged(true)
    mkdirSync(join(tmp, 'kb-models'), { recursive: true })
    vi.mocked(getBuiltinKbModelDir).mockReturnValue(join(tmp, 'kb-models'))
    expect(isFullBuild()).toBe(true)
  })

  it('打包 + 不含 kb-models（slim 包）→ false', () => {
    setPackaged(true)
    vi.mocked(getBuiltinKbModelDir).mockReturnValue(join(tmp, 'nope-kb-models'))
    expect(isFullBuild()).toBe(false)
  })
})

