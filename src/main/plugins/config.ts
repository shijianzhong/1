// —— 插件 configSchema 运行时解析（docs/PLUGIN_ARCHITECTURE.md §3 + §6 密钥铁律）——
//
// 把插件 manifest.configSchema 解析成 handler ctx 用的 config 对象：
// - secret 字段：经 host.secrets.get(vaultKeyId) 在主进程解析明文（明文只存在于主进程内存，
//   不落渲染层、不进沙箱代码字符串，符合铁律「密钥不入渲染进程」）。
// - 非 secret 字段：取声明 default（未声明则 undefined）。
//
// 结构校验（validatePluginConfigSchema）是注册点闸门——由插件 onLoad 在 trusted 判定之前
// 统一调用（generated_b/external 两分支都过），本函数假定 schema 已通过校验，只做运行时解析。
// 这样"校验只在一处"，避免 onLoad 与解析函数双重校验（幂等但易漂移）。

import type { PluginConfigField } from '@shared/types'
import type { PluginHost } from './contracts'

/**
 * 按 manifest.configSchema 解析出 handler ctx.config。
 * 调用方须保证 configSchema 已通过 validatePluginConfigSchema（onLoad 注册点闸门）。
 * @param host 插件宿主（提供 secrets 解析入口）
 * @param configSchema 插件声明的配置项（OnePluginManifest.configSchema）
 */
export async function resolvePluginConfig(
  host: PluginHost,
  configSchema: PluginConfigField[] | undefined,
): Promise<Record<string, unknown>> {
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
  return config
}
