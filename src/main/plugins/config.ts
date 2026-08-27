// —— 插件 configSchema 运行时解析（docs/PLUGIN_ARCHITECTURE.md §3 + §6 密钥铁律）——
//
// 把插件 manifest.configSchema 解析成 handler ctx 用的 config 对象：
// - secret 字段：经 host.secrets.get(vaultKeyId) 在主进程解析明文（明文只存在于主进程内存，
//   不落渲染层、不进沙箱代码字符串，符合铁律「密钥不入渲染进程」）。
// - 非 secret 字段：取声明 default（未声明则 undefined）。
// 解析前先过 validatePluginConfigSchema（注册点 fail-closed 的同源校验），非法直接返回错误，
// 由 onLoad 据此拒绝注册 + 记 pluginEvents。

import type { PluginConfigField } from '@shared/types'
import type { PluginHost } from './contracts'
import { validatePluginConfigSchema, type ValidateFailureReason } from './whitelist'

/** 解析结果：ok 带 config；失败复用 ValidateResult 结构（reason + messageKey） */
export type ResolvePluginConfigResult =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; reason: ValidateFailureReason; messageKey: string }

/**
 * 按 manifest.configSchema 解析出 handler ctx.config。
 * @param host 插件宿主（提供 secrets 解析入口）
 * @param configSchema 插件声明的配置项（OnePluginManifest.configSchema）
 */
export async function resolvePluginConfig(
  host: PluginHost,
  configSchema: PluginConfigField[] | undefined,
): Promise<ResolvePluginConfigResult> {
  const v = validatePluginConfigSchema(configSchema)
  if (!v.ok) return v
  const config: Record<string, unknown> = {}
  if (configSchema) {
    for (const field of configSchema) {
      if (field.secret) {
        const plain = host.secrets ? await host.secrets.get(field.vaultKeyId ?? '') : null
        config[field.name] = plain
      } else {
        config[field.name] = field.default
      }
    }
  }
  return { ok: true, config }
}
