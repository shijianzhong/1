import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// —— flat-index.ts 单测（内存库 + vi.mock getDb，同 store.test.ts 模式）——
// 关键覆盖：
//  - 非分片：5 已知归一化向量，query=v[0]→Top1 score≈1.0 + 排序正确
//  - 空库 search 返回空 + degraded=false
//  - 维度不匹配（漂移场景）→ degraded=true
//  - 分片路径（sharded）：
//      • 无 docIds → degraded=true（调用方走纯 FTS，§四:148）
//      • 给 docIds → 只扫命中文档分片
//      • docIds 全不命中 → degraded=true
//  - invalidate() 重置
//
// 分片路径不通过插 >HARD_CAP(20000) 行触发（太重），而是直接注入单例私有状态
// （TS private 仅编译期，运行时可访问）——等价测 searchSharded 真实代码路径。

let memDb: Database.Database

vi.mock('../storage/db', () => ({
  getDb: () => memDb,
}))

const { flatIndex } = await import('./flat-index')

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_chunks (
      id TEXT PRIMARY KEY,
      kb_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      chunk_idx INTEGER NOT NULL,
      content TEXT NOT NULL,
      vec BLOB,
      vec_dim INTEGER,
      meta TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(doc_id, chunk_idx)
    );
  `)
  return db
}

/** Float32Array → Buffer（独立 ArrayBuffer，byteOffset=0） */
function vecBuf(arr: number[]): Buffer {
  const f = new Float32Array(arr)
  return Buffer.from(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength))
}

beforeEach(() => {
  memDb = freshDb()
  flatIndex.invalidate()
})

describe('非分片：Top-k cosine（已归一化 → 点积）', () => {
  it('5 向量，query=v[0]→Top1 score≈1.0，排序降序', () => {
    // 归一化 3D 向量：raw 用于 query Float32Array，buf 用于 BLOB 列
    const v0raw = [1, 0, 0]
    const v1raw = [0.8, 0.6, 0] // |v1|=1
    const v2raw = [0, 1, 0]
    const v3raw = [0, 0, 1]
    const v4raw = [0.6, 0.8, 0] // |v4|=1
    const ins = memDb.prepare(
      'INSERT INTO kb_chunks (id, kb_id, doc_id, chunk_idx, content, vec, vec_dim, created_at) VALUES (?,?,?,?,?,?,?,?)',
    )
    const rows = [
      ['c0', 'kb', 'docA', 0, 'a', vecBuf(v0raw), 3],
      ['c1', 'kb', 'docA', 1, 'b', vecBuf(v1raw), 3],
      ['c2', 'kb', 'docB', 0, 'c', vecBuf(v2raw), 3],
      ['c3', 'kb', 'docB', 1, 'd', vecBuf(v3raw), 3],
      ['c4', 'kb', 'docC', 0, 'e', vecBuf(v4raw), 3],
    ]
    for (const r of rows) ins.run(...r, Date.now())

    flatIndex.load()
    expect(flatIndex.isLoaded).toBe(true)
    expect(flatIndex.isSharded).toBe(false)
    expect(flatIndex.count).toBe(5)
    expect(flatIndex.dimension).toBe(3)

    const { results, degraded } = flatIndex.search(Float32Array.from(v0raw), { topK: 5 })
    expect(degraded).toBe(false)
    expect(results.length).toBe(5)
    // Top1 = c0，score ≈ 1.0
    expect(results[0].id).toBe('c0')
    expect(results[0].score).toBeCloseTo(1.0, 5)
    // 降序
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score)
    expect(results[1].score).toBeGreaterThanOrEqual(results[2].score)
    // v1(0.8) 排在 v4(0.6) 前
    const c1Idx = results.findIndex((r) => r.id === 'c1')
    const c4Idx = results.findIndex((r) => r.id === 'c4')
    expect(c1Idx).toBeLessThan(c4Idx)
  })

  it('topK 截断', () => {
    const ins = memDb.prepare(
      'INSERT INTO kb_chunks (id, kb_id, doc_id, chunk_idx, content, vec, vec_dim, created_at) VALUES (?,?,?,?,?,?,?,?)',
    )
    ins.run('c0', 'kb', 'docA', 0, 'a', vecBuf([1, 0, 0]), 3, 1)
    ins.run('c1', 'kb', 'docA', 1, 'b', vecBuf([0.8, 0.6, 0]), 3, 1)
    ins.run('c2', 'kb', 'docA', 2, 'c', vecBuf([0.6, 0.8, 0]), 3, 1)
    flatIndex.load()
    const { results } = flatIndex.search(Float32Array.from([1, 0, 0]), { topK: 2 })
    expect(results.length).toBe(2)
  })
})

describe('空库 / 维度漂移', () => {
  it('空库 search 返回空 + degraded=false', () => {
    flatIndex.load()
    expect(flatIndex.count).toBe(0)
    const { results, degraded } = flatIndex.search(Float32Array.from([1, 0, 0]))
    expect(results).toEqual([])
    expect(degraded).toBe(false)
  })

  it('维度不匹配（query dim ≠ index dim）→ degraded=true', () => {
    const ins = memDb.prepare(
      'INSERT INTO kb_chunks (id, kb_id, doc_id, chunk_idx, content, vec, vec_dim, created_at) VALUES (?,?,?,?,?,?,?,?)',
    )
    ins.run('c0', 'kb', 'docA', 0, 'a', vecBuf([1, 0, 0]), 3, 1)
    flatIndex.load()
    expect(flatIndex.dimension).toBe(3)
    // query 4 维 ≠ index 3 维
    const { results, degraded } = flatIndex.search(Float32Array.from([1, 0, 0, 0]))
    expect(results).toEqual([])
    expect(degraded).toBe(true)
  })
})

describe('分片路径（注入私有状态测真实 searchSharded）', () => {
  // 构造 2 文档分片：docA=[c0,c1], docB=[c2]
  function injectSharded(): void {
    const fx = flatIndex as unknown as {
      dim: number
      loaded: boolean
      sharded: boolean
      shardedState: {
        byDoc: Map<string, Float32Array>
        idsByDoc: Map<string, string[]>
      }
    }
    fx.dim = 3
    fx.loaded = true
    fx.sharded = true
    fx.shardedState = {
      byDoc: new Map([
        ['docA', new Float32Array([1, 0, 0, 0.8, 0.6, 0])], // c0,c1
        ['docB', new Float32Array([0, 1, 0])], // c2
      ]),
      idsByDoc: new Map([
        ['docA', ['c0', 'c1']],
        ['docB', ['c2']],
      ]),
    }
  }

  it('sharded 无 docIds → degraded=true（调用方走纯 FTS）', () => {
    injectSharded()
    const { results, degraded } = flatIndex.search(Float32Array.from([1, 0, 0]))
    expect(results).toEqual([])
    expect(degraded).toBe(true)
  })

  it('sharded 给 docIds → 只扫命中文档分片', () => {
    injectSharded()
    const { results, degraded } = flatIndex.search(Float32Array.from([1, 0, 0]), {
      docIds: ['docA'],
    })
    expect(degraded).toBe(false)
    // 只扫 docA（c0,c1），不扫 docB（c2）
    const ids = results.map((r) => r.id)
    expect(ids).toContain('c0')
    expect(ids).toContain('c1')
    expect(ids).not.toContain('c2')
    // Top1 = c0 score 1.0
    expect(results[0].id).toBe('c0')
    expect(results[0].score).toBeCloseTo(1.0, 5)
  })

  it('sharded docIds 全不命中 → degraded=true', () => {
    injectSharded()
    const { results, degraded } = flatIndex.search(Float32Array.from([1, 0, 0]), {
      docIds: ['docX'], // 不存在
    })
    expect(results).toEqual([])
    expect(degraded).toBe(true)
  })
})

describe('invalidate()', () => {
  it('重置 loaded/dim/count', () => {
    const ins = memDb.prepare(
      'INSERT INTO kb_chunks (id, kb_id, doc_id, chunk_idx, content, vec, vec_dim, created_at) VALUES (?,?,?,?,?,?,?,?)',
    )
    ins.run('c0', 'kb', 'docA', 0, 'a', vecBuf([1, 0, 0]), 3, 1)
    flatIndex.load()
    expect(flatIndex.isLoaded).toBe(true)
    expect(flatIndex.count).toBe(1)
    flatIndex.invalidate()
    expect(flatIndex.isLoaded).toBe(false)
    expect(flatIndex.count).toBe(0)
    expect(flatIndex.dimension).toBe(0)
  })
})
