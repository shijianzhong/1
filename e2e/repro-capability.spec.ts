import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, cpSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

// —— @能力 directCap 真实 IPC 复刻测试（concurrent 503 / 空白气泡问题）——
// 复制真实 userData（含真能力图 + 真 provider 凭据 + 真 agent/skill），
// 走完整 IPC：window.one.home.chat → home:chat → resolveMentions → directCap →
// buildWorkflow(concurrent) → runWorkflow → 真 LLM。
// 重复 N 次观察 503 是否偶发 + 空白气泡复现率。

const REAL_USER_DATA = join(homedir(), 'Library', 'Application Support', 'one')
const RUNS = 3

interface StreamEvent {
  type: string
  text?: string
  speaker?: string
  final?: boolean
  error?: string
  stop_reason?: string
  [k: string]: unknown
}

/** 复制真实 userData 的关键数据到隔离目录（不污染真库，凭据同机可解） */
function seedUserData(dst: string): void {
  // config 目录（agents / capabilities / skills / providers.json / persona.json）
  cpSync(join(REAL_USER_DATA, 'config'), join(dst, 'config'), { recursive: true })
  // SQLite（含 WAL，保证并发能力/agent 数据完整）
  for (const f of ['one.db', 'one.db-wal', 'one.db-shm']) {
    const src = join(REAL_USER_DATA, f)
    if (existsSync(src)) cpSync(src, join(dst, f))
  }
  // vault（safeStorage 加密 blob，同机 keychain 可解出真 LLM key）
  const vault = join(REAL_USER_DATA, 'vault.bin')
  if (existsSync(vault)) cpSync(vault, join(dst, 'vault.bin'))
}

async function launchReal(): Promise<{ app: ElectronApplication; win: Page; userData: string }> {
  const userData = mkdtempSync(join(tmpdir(), 'one-repro-'))
  seedUserData(userData)
  // Cursor/agent 环境会注入 ELECTRON_RUN_AS_NODE=1，使 Electron 以纯 Node 模式运行并拒绝
  // --remote-debugging-port → launch 直接失败。启动前必须剔除该变量。
  const { ELECTRON_RUN_AS_NODE: _drop, ...cleanEnv } = process.env
  void _drop
  const app = await electron.launch({
    args: [resolve('out/main/index.cjs')],
    env: { ...cleanEnv, NODE_ENV: 'test', ONE_USER_DATA: userData },
  })
  // 捕获主进程 stdout/stderr（含 logger console 输出），诊断凭据/认证问题
  app.process().stdout?.on('data', (d) => process.stdout.write(`[main:out] ${d}`))
  app.process().stderr?.on('data', (d) => process.stdout.write(`[main:err] ${d}`))
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(
    () => (window as unknown as { one?: unknown }).one !== undefined,
    { timeout: 15000 },
  )

  // vault 跨 Electron 实例 safeStorage 解密失败（Keychain 与 app 绑定）→ 用测试实例自己的
  // safeStorage 经 setLLMConfig 写入真 key（TEST_LLM_KEY env 注入），让 resolveProviderCredentials 能解出。
  const testKey = process.env.TEST_LLM_KEY
  if (testKey) {
    await win.evaluate(async (apiKey) => {
      const w = window as unknown as {
        one: { secrets: { setLLMConfig: (c: { keyId: string; apiKey: string }) => Promise<unknown> } }
      }
      await w.one.secrets.setLLMConfig({ keyId: 'preset_key_anthropic', apiKey })
    }, testKey)
  }
  return { app, win, userData }
}

/** 跑一次 @内容生产闭环，返回收集到的流式事件 + 最终拼接文本 */
async function runOnce(win: Page): Promise<{ events: StreamEvent[]; finalText: string }> {
  // 挂事件收集器
  await win.evaluate(() => {
    const w = window as unknown as {
      one: { home: { onStream: (cb: (d: unknown) => void) => () => void } }
      __events?: unknown[]
    }
    w.__events = []
    w.one.home.onStream((d) => w.__events!.push(d))
  })

  // 真实 IPC 调用（message = 芯片序列化后的真实格式）
  await win.evaluate(async () => {
    const w = window as unknown as {
      one: { home: { chat: (i: { message: string }) => Promise<unknown> } }
    }
    await w.one.home.chat({ message: '@内容生产闭环 你能做什么' })
  })

  // 等 message_stop（最多 90s，concurrent 多 agent 较慢）
  await win.waitForFunction(
    () => {
      const w = window as unknown as { __events?: Array<{ type: string }> }
      return w.__events?.some((e) => e.type === 'message_stop') ?? false
    },
    { timeout: 90000 },
  )

  const events = (await win.evaluate(() => {
    return (window as unknown as { __events?: unknown[] }).__events ?? []
  })) as StreamEvent[]

  // 拼接最终文本：final output 事件（终端完整输出），fallback 增量拼接
  const finals = events.filter((e) => e.type === 'orch_event' || e.type === 'text')
  let finalText = ''
  const finalOutputs = events.filter(
    (e) => (e as { event?: { type?: string; final?: boolean } }).event?.type === 'output' &&
      (e as { event?: { final?: boolean } }).event?.final,
  )
  if (finalOutputs.length > 0) {
    finalText = finalOutputs
      .map((e) => ((e as { event?: { text?: string } }).event?.text ?? ''))
      .join('')
  } else {
    finalText = finals.map((e) => e.text ?? '').join('')
  }
  return { events, finalText }
}

test.describe('@能力 directCap 真实 IPC 复刻', () => {
  test.setTimeout(300000)

  test(`@内容生产闭环 你能做什么 ×${RUNS} 次，观察 503/空白气泡`, async () => {
    const { app, win, userData } = await launchReal()
    try {
      for (let i = 1; i <= RUNS; i++) {
        const { events, finalText } = await runOnce(win)
        const retryEvents = events.filter((e) => e.type === 'retry')
        const errorEvents = events.filter((e) => e.type === 'error')
        const outputEvents = events.filter(
          (e) => (e as { event?: { type?: string } }).event?.type === 'output',
        )
        console.log(`\n===== 第 ${i} 次 =====`)
        console.log(`事件总数: ${events.length}, output 事件: ${outputEvents.length}, retry: ${retryEvents.length}, error: ${errorEvents.length}`)
        // 打印完整事件类型序列 + orch_event 明细（诊断为何无 output）
        console.log('事件序列:', JSON.stringify(events.map((e) => e.type)))
        const orchEvents = events.filter((e) => e.type === 'orch_event')
        console.log('orch_event 明细:', JSON.stringify(orchEvents.map((e) => (e as { event?: unknown }).event), null, 1).slice(0, 2000))
        if (retryEvents.length > 0) console.log('retry 明细:', JSON.stringify(retryEvents))
        if (errorEvents.length > 0) console.log('error 明细:', JSON.stringify(errorEvents))
        console.log(`最终文本长度: ${finalText.length}`)
        console.log(`最终文本头 200 字: ${finalText.slice(0, 200)}`)
      }
      // 不硬性断言非空（目的就是观察复现率），只打印
    } finally {
      await app.close()
      rmSync(userData, { recursive: true, force: true })
    }
  })
})
