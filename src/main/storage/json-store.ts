import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { logger } from '../logger'

// —— JSON 文件存储工具（§5.2）——
// 配置类（capability/agent/skill/model/persona）存 JSON；
// 原子写盘（临时文件 + rename，§11.4）。
//
// 【设计权衡：同步 fs（CODE_AUDIT 断言 3.1 CONFIRMED，接受为设计缺口）】
// 主进程单线程，writeFileSync/readFileSync 阻塞期间所有 IPC + UI 冻结——机制上成立。
// 但本存储承载的是配置类小 JSON（capability/agent/skill/model/persona，单文件通常 < 数十 KB），
// 同步 fs 在 SSD 上耗时亚毫秒级，不构成可感知卡顿。CLAUDE.md §11.4 只规定「原子写盘」，
// 未要求 I/O 异步化——故维持同步。
// 若将来出现大文件 I/O（如 skill 包内联文本膨胀到 MB 级、或频繁批量写），再异步化：
// 方法签名 read→Promise<T>、write→Promise<T>，调用链 models.ts（~20 方法）+ 18 个 IPC/工具
// 调用方全部串联 await（IPC handler 经 withHandler 已包 Promise，改动可承受）。
// 当前不做此大改，避免为一亚毫秒级缺口引入 ~80 处 await 串联的回归风险。

/** 生成短 id（8 字节 hex + 时间戳后 4 位，避免 Math.random） */
export function generateId(prefix = ''): string {
  const ts = Date.now().toString(36).slice(-4)
  const rand = randomBytes(8).toString('hex')
  return `${prefix}${ts}${rand}`
}

/** 原子写 JSON 文件 */
export function writeJsonFile(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  // 临时名带随机后缀，防同路径并发/多进程写时临时文件互踩（同 ipc/writeJsonAtomic 的修法）
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, path)
}

/** 读 JSON 文件，不存在/损坏返回 fallback */
export function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch (error) {
    logger.warn(`[json-store] 读取失败 ${path}`, error)
    return fallback
  }
}

/** 删除文件（不存在静默） */
export function removeFile(path: string): void {
  if (existsSync(path)) unlinkSync(path)
}

/**
 * 多文件集合存储（每实体一个文件，目录下 {id}.json）。
 * 用于 capability / agent / skill。
 */
export class JsonCollection<T extends { id: string }> {
  constructor(
    private readonly dir: string,
    private readonly fromJson: (raw: unknown) => T,
  ) {}

  list(): T[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => this.read(join(this.dir, f)))
      .filter((v): v is T => v !== null)
  }

  get(id: string): T | null {
    return this.read(this.path(id))
  }

  save(item: T): T {
    writeJsonFile(this.path(item.id), item)
    return item
  }

  remove(id: string): void {
    removeFile(this.path(id))
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  private read(path: string): T | null {
    const raw = readJsonFile<unknown>(path, null)
    if (raw === null) return null
    try {
      return this.fromJson(raw)
    } catch {
      return null
    }
  }
}

/** 单文件存储（整集合一个文件）。用于 models / persona。 */
export class JsonSingleton<T> {
  constructor(
    private readonly path: string,
    private readonly fallback: T,
    private readonly fromJson: (raw: unknown) => T,
  ) {}

  read(): T {
    return this.fromJson(readJsonFile(this.path, this.fallback))
  }

  write(data: T): T {
    writeJsonFile(this.path, data)
    return data
  }
}
