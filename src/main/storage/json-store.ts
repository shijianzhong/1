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

/** 生成短 id（8 字节 hex + 时间戳后 4 位，避免 Math.random） */
export function generateId(prefix = ''): string {
  const ts = Date.now().toString(36).slice(-4)
  const rand = randomBytes(8).toString('hex')
  return `${prefix}${ts}${rand}`
}

/** 原子写 JSON 文件 */
export function writeJsonFile(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
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
