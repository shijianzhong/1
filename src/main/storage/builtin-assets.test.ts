import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { AgentSchema } from '../config'
import { parseSkillMd } from './skills/parser'

// —— builtin 出厂资产 schema 校验（P3，docs/CONTENT_PIPELINE_PLAN.md §5.4）——
// 确保 build/builtin/agents/*.json 能过 AgentSchema、build/builtin/skills/*/SKILL.md
// 能过 parseSkillMd —— 首启 seedBuiltinAssets 复制后引擎能正常加载。
// build 目录相对 cwd（vitest 跑在项目根）。

const BUILTIN_AGENTS_DIR = join(process.cwd(), 'build', 'builtin', 'agents')
const BUILTIN_SKILLS_DIR = join(process.cwd(), 'build', 'builtin', 'skills')

describe('builtin agents schema', () => {
  const files = readdirSync(BUILTIN_AGENTS_DIR).filter((f) => f.endsWith('.json'))

  it('有 6 个 builtin agent', () => {
    expect(files.length).toBe(6)
  })

  for (const file of files) {
    const id = file.replace(/\.json$/, '')
    it(`${id} 过 AgentSchema 且 source=builtin`, () => {
      const raw = JSON.parse(readFileSync(join(BUILTIN_AGENTS_DIR, file), 'utf8'))
      const agent = AgentSchema.parse(raw) // 不抛=过
      expect(agent.source).toBe('builtin')
      expect(agent.name).toBeTruthy()
      expect(agent.instructions).toBeTruthy()
      // 固定 id（前缀 builtin_content_）
      expect(agent.id).toBe(id)
      // 绑定至少一个 skill + 工具白名单非空
      expect(agent.skillIds?.length).toBeGreaterThanOrEqual(1)
      expect(agent.allowedToolNames?.length).toBeGreaterThanOrEqual(1)
    })
  }
})

describe('builtin skills parse', () => {
  const dirs = readdirSync(BUILTIN_SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)

  it('有 6 个 builtin skill', () => {
    expect(dirs.length).toBe(6)
  })

  for (const dir of dirs) {
    it(`${dir}/SKILL.md 能解析出 name+content+discipline`, () => {
      const md = readFileSync(join(BUILTIN_SKILLS_DIR, dir, 'SKILL.md'), 'utf8')
      const parsed = parseSkillMd(md)
      expect(parsed, `${dir} SKILL.md 解析失败`).not.toBeNull()
      expect(parsed!.name).toBeTruthy()
      expect(parsed!.content.length).toBeGreaterThan(100) // 有实质内容
      expect(parsed!.discipline).toBeTruthy() // 必有输出纪律段
    })
  }
})

describe('builtin 内容索引（isBuiltinSeeded 引用项真实存在）', () => {
  it('builtin_content_researcher.json 存在', () => {
    const exists = readdirSync(BUILTIN_AGENTS_DIR).includes('builtin_content_researcher.json')
    expect(exists).toBe(true)
  })
  it('topic-research-discipline skill 存在', () => {
    const exists = readdirSync(BUILTIN_SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .includes('topic-research-discipline')
    expect(exists).toBe(true)
  })
})

describe('builtin capability schema', () => {
  const BUILTIN_CAPS_DIR = join(process.cwd(), 'build', 'builtin', 'capabilities')
  const files = readdirSync(BUILTIN_CAPS_DIR).filter((f) => f.endsWith('.json'))

  it('有 1 个 builtin capability（content-pipeline）', () => {
    expect(files.length).toBe(1)
    // 文件名必须与 id 一致：JsonCollection.get(id) 按 {id}.json 读
    // （json-store.ts path() = join(dir, `${id}.json`)），否则 getCapability(id) 返回 null。
    expect(files).toContain('builtin_content_pipeline.json')
  })

  it('builtin_content_pipeline.json 文件名 == 内部 id（getCapability 不再失配）', () => {
    const file = 'builtin_content_pipeline.json'
    const raw = JSON.parse(readFileSync(join(BUILTIN_CAPS_DIR, file), 'utf8'))
    expect(raw.id).toBe(file.replace(/\.json$/, '')) // 文件名去扩展名 == id
  })

  it('builtin_content_pipeline.json 有 graph + 固定 id + 7 节点', () => {
    const raw = JSON.parse(readFileSync(join(BUILTIN_CAPS_DIR, 'builtin_content_pipeline.json'), 'utf8'))
    expect(raw.id).toBe('builtin_content_pipeline')
    expect(Array.isArray(raw.graph.nodes)).toBe(true)
    expect(raw.graph.nodes.length).toBe(7) // 1 sequential + 6 agent
    expect(raw.graph.nodes.filter((n: { type: string }) => n.type === 'agent').length).toBe(6)
  })
})
