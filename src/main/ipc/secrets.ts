import type { LLMConfig } from '@shared/types'
import { withHandler } from './handler'
import { getKey, isVaultAvailable, removeKey, setKey } from '../secrets/vault'

// —— LLM key 加密存储 IPC（§八之二 B + 铁律3）——
// 渲染层经 window.one.secrets.* 读写，明文 key 不回传渲染层（getLLMConfig
// 只回 baseUrl/defaultModel，apiKey 解密后留在主进程供 LLM client 用）。
export function registerSecretsHandlers(): void {
  withHandler<{ baseUrl?: string; defaultModel?: string; hasKey: boolean }>(
    'secrets:getLLMConfig',
    (_e, keyId) => {
      const id = keyId as string
      const key = id ? getKey(id) : null
      // 明文 key 不出主进程；hasKey 供渲染层判断是否已配 key
      return { hasKey: !!key }
    },
  )

  withHandler<void>('secrets:setLLMConfig', (_e, input) => {
    const cfg = input as LLMConfig & { keyId?: string }
    if (!cfg.keyId) throw new Error('keyId 必填')
    if (cfg.apiKey) {
      if (!isVaultAvailable()) throw new Error('safeStorage 不可用')
      setKey(cfg.keyId, cfg.apiKey)
    }
    // baseUrl/defaultModel 存到 model 配置（阶段2 client 读取），此处只管 key
  })

  withHandler<void>('secrets:removeKey', (_e, keyId) =>
    removeKey(keyId as string),
  )

  // 阶段2 接入 LLM client 后实装；骨架先返回 vault 可用性
  withHandler<{ ok: boolean; error?: string }>('secrets:testLLM', () => ({
    ok: isVaultAvailable(),
  }))
}
