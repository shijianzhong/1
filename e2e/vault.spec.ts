import { expect, test } from '@playwright/test'
import { launchApp } from './fixtures'

// —— vault 加解密一致性测试（§10.3 + §11.4）——
// safeStorage 必须在 electron 主进程跑，故走 E2E 而非 vitest。
// 验证：setKey → getKey 一致；removeKey 后 getKey 返回 null。
test('secrets vault: set/get/remove key roundtrip', async () => {
  const { win, cleanup } = await launchApp()
  const keyId = 'e2e-test-key'

  // set
  const setRes = await win.evaluate(async (id) => {
    return (await (window as unknown as {
      one: { secrets: { setLLMConfig: (cfg: { keyId: string; apiKey: string }) => Promise<{ ok: boolean }> } }
    }).one.secrets.setLLMConfig({ keyId: id, apiKey: 'sk-e2e-secret' }))
  }, keyId)
  expect(setRes.ok).toBe(true)

  // get → hasKey true
  const getRes = await win.evaluate(async (id) => {
    return (await (window as unknown as {
      one: { secrets: { getLLMConfig: (keyId: string) => Promise<{ ok: boolean; data?: { hasKey: boolean } }> } }
    }).one.secrets.getLLMConfig(id))
  }, keyId)
  expect(getRes).toMatchObject({ ok: true, data: { hasKey: true } })

  // remove
  const rmRes = await win.evaluate(async (id) => {
    return (await (window as unknown as {
      one: { secrets: { removeKey: (keyId: string) => Promise<{ ok: boolean }> } }
    }).one.secrets.removeKey(id))
  }, keyId)
  expect(rmRes.ok).toBe(true)

  // get → hasKey false
  const getRes2 = await win.evaluate(async (id) => {
    return (await (window as unknown as {
      one: { secrets: { getLLMConfig: (keyId: string) => Promise<{ ok: boolean; data?: { hasKey: boolean } }> } }
    }).one.secrets.getLLMConfig(id))
  }, keyId)
  expect(getRes2).toMatchObject({ ok: true, data: { hasKey: false } })

  await cleanup()
})
