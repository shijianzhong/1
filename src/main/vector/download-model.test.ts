import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// —— download-model.ts 单测 ——
// 真实临时目录落盘 + stub 全局 fetch（小 Response 体）。关键覆盖：
//  (a) 并发守卫：第二调用挂到在途任务，fetch 只跑一套 FILES（防 .part/rename 竞态 + 双倍拉流）
//  (b) 幂等：全部文件已存在非空 → 零 fetch 直接完成
//  (c) 失败后 inflight 复位：终态错误（4xx 不重试）拒完后下一次调用可重试成功
//  (d) 原子写：完成后无 .part 残留，内容与源一致

const MODEL_ID = 'Xenova/multilingual-e5-small'
// 与 download-model.ts FILES 对齐（未导出，测试内硬编码；换文件集时同步改）
const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.txt',
  'sentencepiece.bpe.model',
  'onnx/model_quantized.onnx',
]

let tmpDir = ''
vi.mock('../storage/paths', () => ({ getKbModelDir: () => tmpDir }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const { downloadKbModel } = await import('./download-model')

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kb-dl-test-'))
  fetchMock.mockReset()
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('downloadKbModel — 并发守卫', () => {
  it('并发第二调用挂到在途任务：fetch 只跑一套，两调用同成功', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    fetchMock.mockImplementation(async () => {
      await gate
      return new Response('model-bytes')
    })

    const p1 = downloadKbModel()
    const p2 = downloadKbModel() // 守卫：挂到 p1 在途任务，不起第二趟
    release()
    await Promise.all([p1, p2])

    // 守卫失效则两趟并发 → fetch 2×FILES.length
    expect(fetchMock).toHaveBeenCalledTimes(FILES.length)
    for (const f of FILES) {
      const dest = join(tmpDir, MODEL_ID, f)
      expect(existsSync(dest)).toBe(true)
      expect(readFileSync(dest, 'utf8')).toBe('model-bytes')
      // .part 临时文件全部 rename 完毕，无残留
      expect(existsSync(`${dest}.part`)).toBe(false)
    }
  })
})

describe('downloadKbModel — 幂等', () => {
  it('全部文件已存在非空 → 零 fetch 直接完成', async () => {
    for (const f of FILES) {
      const dest = join(tmpDir, MODEL_ID, f)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, 'seed')
    }

    await downloadKbModel()

    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('downloadKbModel — 失败复位', () => {
  it('终态错误（403 不重试）拒绝后 inflight 复位，下一次调用可重试成功', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 403 }))
    await expect(downloadKbModel()).rejects.toThrow('403')

    // 注意必须每次调用造新 Response：同一实例 body 只能消费一次（locked stream）
    fetchMock.mockImplementation(() => Promise.resolve(new Response('ok-bytes')))
    await downloadKbModel()
    expect(readFileSync(join(tmpDir, MODEL_ID, 'config.json'), 'utf8')).toBe('ok-bytes')
  })
})
