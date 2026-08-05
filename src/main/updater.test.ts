import { describe, expect, it } from 'vitest'
import { isBenignNoReleaseError } from './updater-errors'

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
