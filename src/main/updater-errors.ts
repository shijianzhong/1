/**
 * 判定是否为「仓库尚无已发布版本」类预期错误。
 * 错误形态来自 electron-updater GitHubProvider（draft-only / 空 releases）。
 * 独立文件：无 electron 依赖，可供 vitest 直接测。
 */
export function isBenignNoReleaseError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  return (
    /Unable to find latest version/i.test(msg) ||
    /Cannot parse releases feed/i.test(msg) ||
    (/HttpError:\s*406/.test(msg) && /releases/i.test(msg)) ||
    /please ensure a production release exists/i.test(msg)
  )
}
