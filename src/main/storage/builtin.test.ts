import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// builtin seed 的核心逻辑是文件复制，与 Electron app 无关——
// mock paths 把 builtin 源/目标都重定向到临时目录，直接测复制行为。

let builtinRoot: string // 出厂源（build/builtin 替身）
let userDataRoot: string // userData 可写层替身
let srcAgents: string
let destAgents: string
let destSkills: string
let srcSkills: string
let destTemplates: string
let srcTemplates: string
let destSample: string
let srcSample: string
let destCaps: string
let srcCaps: string
let destModels: string
let destProviders: string
let destStyleProfiles: string
let destPersona: string

vi.mock('./paths', () => ({
  getBuiltinResourcesDir: () => builtinRoot,
  getBuiltinAgentsDir: () => srcAgents,
  getBuiltinCapabilitiesDir: () => srcCaps,
  getBuiltinSkillsDir: () => srcSkills,
  getBuiltinSampleArticlesDir: () => srcSample,
  getBuiltinTemplatesDir: () => srcTemplates,
  getAgentsPath: () => destAgents,
  getCapabilitiesDir: () => destCaps,
  getSkillsPath: () => destSkills,
  getSampleArticlesPath: () => destSample,
  getTemplatesPath: () => destTemplates,
  // models.ts 模块加载期即构造各 store，需指向临时目录（回归测试 import getCapability 时触达）
  getModelsPath: () => destModels,
  getProvidersPath: () => destProviders,
  getStyleProfilesDir: () => destStyleProfiles,
  getPersonaPath: () => destPersona,
}))

const { seedBuiltinAssets, listBuiltinAssets, isBuiltinSeeded } = await import('./builtin')

// logger 无害 mock
vi.mock('../logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}))

function freshDirs() {
  builtinRoot = mkdtempSync(join(tmpdir(), 'builtin-src-'))
  userDataRoot = mkdtempSync(join(tmpdir(), 'builtin-dest-'))
  srcAgents = join(builtinRoot, 'agents')
  srcCaps = join(builtinRoot, 'capabilities')
  srcSkills = join(builtinRoot, 'skills')
  srcSample = join(builtinRoot, 'sample-articles')
  srcTemplates = join(builtinRoot, 'templates')
  destAgents = join(userDataRoot, 'config', 'agents')
  destCaps = join(userDataRoot, 'config', 'capabilities')
  destSkills = join(userDataRoot, 'config', 'skills')
  destSample = join(userDataRoot, 'config', 'sample-articles')
  destTemplates = join(userDataRoot, 'config', 'templates')
  destModels = join(userDataRoot, 'config', 'models.json')
  destProviders = join(userDataRoot, 'config', 'providers.json')
  destStyleProfiles = join(userDataRoot, 'config', 'style-profiles')
  destPersona = join(userDataRoot, 'config', 'persona.json')
}

function seedSource() {
  // 出厂源放 2 个 agent、1 个 capability、1 个 skill 目录、1 个样文目录、1 个模板
  mkdirSync(srcAgents, { recursive: true })
  writeFileSync(join(srcAgents, 'builtin_content_research_gh.json'), '{"id":"builtin_content_research_gh"}')
  writeFileSync(join(srcAgents, 'builtin_content_writer.json'), '{"id":"builtin_content_writer"}')
  mkdirSync(srcCaps, { recursive: true })
  writeFileSync(join(srcCaps, 'builtin_content_pipeline.json'), '{"id":"builtin_content_pipeline"}')
  mkdirSync(join(srcSkills, 'writing-style'), { recursive: true })
  writeFileSync(join(srcSkills, 'writing-style', 'SKILL.md'), '---\nname: writing-style\n---\n# content')
  mkdirSync(srcSample, { recursive: true })
  mkdirSync(join(srcSample, 'sample-a', 'references'), { recursive: true })
  writeFileSync(join(srcSample, 'sample-a', 'ARTICLE.md'), 'article body')
  writeFileSync(join(srcSample, 'sample-a', 'references', 'ref.md'), 'ref')
  mkdirSync(srcTemplates, { recursive: true })
  writeFileSync(join(srcTemplates, 'wechat-poster.html'), '<html></html>')
}

beforeEach(() => {
  freshDirs()
})

describe('storage/builtin seedBuiltinAssets', () => {
  it('首启复制：agent/capability/skill/样文/模板 全部落地', () => {
    seedSource()
    seedBuiltinAssets()
    // agent 单文件
    expect(existsSync(join(destAgents, 'builtin_content_research_gh.json'))).toBe(true)
    expect(existsSync(join(destAgents, 'builtin_content_writer.json'))).toBe(true)
    // capability 单文件
    expect(existsSync(join(destCaps, 'builtin_content_pipeline.json'))).toBe(true)
    // skill 目录（含 SKILL.md）
    expect(existsSync(join(destSkills, 'writing-style', 'SKILL.md'))).toBe(true)
    // 样文目录（含子目录 references/）
    expect(existsSync(join(destSample, 'sample-a', 'ARTICLE.md'))).toBe(true)
    expect(existsSync(join(destSample, 'sample-a', 'references', 'ref.md'))).toBe(true)
    // 模板单文件
    expect(existsSync(join(destTemplates, 'wechat-poster.html'))).toBe(true)
  })

  it('幂等：二次调用不覆盖已有（保用户改动）', () => {
    seedSource()
    seedBuiltinAssets()
    // 用户改了 agent
    const agentPath = join(destAgents, 'builtin_content_writer.json')
    writeFileSync(agentPath, '{"id":"builtin_content_writer","userEdited":true}')
    // 用户改了 skill
    const skillPath = join(destSkills, 'writing-style', 'SKILL.md')
    writeFileSync(skillPath, '---\nname: user-changed\n---\n# changed by user')
    // 再 seed
    seedBuiltinAssets()
    // 用户改动保留
    expect(readFileSync(agentPath, 'utf8')).toContain('userEdited')
    expect(readFileSync(skillPath, 'utf8')).toContain('user-changed')
  })

  it('幂等：目标已存在的文件不复制', () => {
    seedSource()
    seedBuiltinAssets()
    const beforeStat = readFileSync(join(destAgents, 'builtin_content_writer.json'), 'utf8')
    // 源变了（模拟官方升级）
    writeFileSync(join(srcAgents, 'builtin_content_writer.json'), '{"id":"builtin_content_writer","v":2}')
    seedBuiltinAssets()
    // 目标不变（存在即跳过，不覆盖）
    expect(readFileSync(join(destAgents, 'builtin_content_writer.json'), 'utf8')).toBe(beforeStat)
  })

  it('空源不报错（无 builtin 资产时安全跳过）', () => {
    // 不 seedSource，builtin 源目录不存在
    expect(() => seedBuiltinAssets()).not.toThrow()
    expect(existsSync(destAgents)).toBe(false)
  })

  it('部分已落地：只复制缺失的，已有的保留', () => {
    seedSource()
    // 预先放一个已存在的 agent
    mkdirSync(destAgents, { recursive: true })
    writeFileSync(join(destAgents, 'builtin_content_writer.json'), '{"preset":true}')
    seedBuiltinAssets()
    // 已有的不动
    expect(readFileSync(join(destAgents, 'builtin_content_writer.json'), 'utf8')).toContain('preset')
    // 缺的补上
    expect(existsSync(join(destAgents, 'builtin_content_research_gh.json'))).toBe(true)
  })

  // issue #2：目录型资产升级回填。老用户 config/skills/ 已存在（首装时复制过 writing-style），
  // 官方升级新增了一个 builtin skill（new-skill）。旧逻辑 copyBuiltinIfAbsent 见目标根目录
  // 已存在就整包跳过 → 老用户永远拿不到 new-skill。新逻辑逐子项回填：缺的补，有的不动。
  it('升级回填：老用户已落地后，新加的 builtin skill 能补发（不整目录跳过）', () => {
    seedSource() // 源含 writing-style
    seedBuiltinAssets() // 首启：writing-style 落地
    expect(existsSync(join(destSkills, 'writing-style', 'SKILL.md'))).toBe(true)

    // 官方升级：源里新增一个 builtin skill
    mkdirSync(join(srcSkills, 'new-builtin-skill'), { recursive: true })
    writeFileSync(
      join(srcSkills, 'new-builtin-skill', 'SKILL.md'),
      '---\nname: new-builtin-skill\n---\n# new',
    )
    // 用户对已有 skill 的改动
    writeFileSync(
      join(destSkills, 'writing-style', 'SKILL.md'),
      '---\nname: user-changed\n---\n# changed by user',
    )

    seedBuiltinAssets() // 升级回填

    // 新 skill 补发到位（关键：老用户拿得到升级内容）
    expect(existsSync(join(destSkills, 'new-builtin-skill', 'SKILL.md'))).toBe(true)
    expect(readFileSync(join(destSkills, 'new-builtin-skill', 'SKILL.md'), 'utf8')).toContain(
      'new-builtin-skill',
    )
    // 已有 skill 的用户改动保留
    expect(readFileSync(join(destSkills, 'writing-style', 'SKILL.md'), 'utf8')).toContain(
      'user-changed',
    )
  })
})

describe('storage/builtin listBuiltinAssets / isBuiltinSeeded', () => {
  it('listBuiltinAssets 列出出厂源清单', () => {
    seedSource()
    const list = listBuiltinAssets()
    expect(list.agents).toContain('builtin_content_research_gh')
    expect(list.agents).toContain('builtin_content_writer')
    expect(list.capabilities).toContain('builtin_content_pipeline')
    expect(list.skills).toContain('writing-style')
    expect(list.sampleArticles).toContain('sample-a')
    expect(list.templates).toContain('wechat-poster')
    expect(list.agents).not.toContain('')
    expect(list.capabilities).not.toContain('')
    expect(list.templates).not.toContain('')
  })

  it('listBuiltinAssets 空源返回空数组', () => {
    const list = listBuiltinAssets()
    expect(list.agents).toEqual([])
    expect(list.skills).toEqual([])
  })

  it('isBuiltinSeeded：未 seed 返 false，seed 后返 true', () => {
    // 未 seed：userData 可写层尚无任何 builtin 资产
    expect(isBuiltinSeeded()).toBe(false)

    // 造一个命中哨兵的源：isBuiltinSeeded 查 builtin_content_researcher.json
    // （真实 builtin agent 名）或 topic-research-discipline skill。seedSource 替身源
    // 用别名，故此处直接放哨兵文件进源，使复制后哨兵命中。
    mkdirSync(srcAgents, { recursive: true })
    writeFileSync(join(srcAgents, 'builtin_content_researcher.json'), '{"id":"x"}')
    seedBuiltinAssets()
    expect(isBuiltinSeeded()).toBe(true)
  })
})

// —— 回归测试（issue #1）：seed 完 builtin 后按 capability id 读取——
// JsonCollection.get(id) 按文件名 {id}.json 读（json-store.ts path()=join(dir,`${id}.json`))。
// 历史缺陷：capability 文件名 content-pipeline.json ≠ 内部 id builtin_content_pipeline，
// listCapabilities() 能列（扫目录），但 getCapability('builtin_content_pipeline') 找
// builtin_content_pipeline.json 不存在 → 返回 null → 按 id 打开/运行能力路径全断（hooks.ts:196）。
// 此测用真实 getCapability（不 mock storage/models），覆盖 seed→getCapability 关键路径。
//
// 关键时序：models.ts 模块加载期即构造 capabilitiesStore（this.dir=getCapabilitiesDir()）。
// ./builtin 不导入 ./models，故 ./models 首次 import 发生在此测试体内（freshDirs 之后），
// hoisted vi.mock('./paths') 的闭包在调用时读 destCaps（已设）→ store.dir 指向 temp destCaps。
describe('storage/builtin 回归：seed 后按 id 读 capability', () => {
  it("getCapability('builtin_content_pipeline') 非 null（文件名==id 不再失配）", async () => {
    // 用 schema 合法的 capability（seedSource 的桩缺 graph，会致 parse 抛→getCapability 返 null，
    // 那是另一个问题；本测聚焦"文件名==id 后按 id 读得到"的真实路径）
    mkdirSync(srcCaps, { recursive: true })
    writeFileSync(
      join(srcCaps, 'builtin_content_pipeline.json'),
      JSON.stringify({
        id: 'builtin_content_pipeline',
        name: '内容生产管线',
        graph: { nodes: [], edges: [] },
        createdAt: 1,
        updatedAt: 1,
      }),
    )
    seedBuiltinAssets() // 复制进 temp userData 的 destCaps
    const { getCapability } = await import('./models') // 此时构造 store，dir→destCaps

    const cap = getCapability('builtin_content_pipeline')
    expect(cap, '文件名==id 后 getCapability 应能按 id 读到').not.toBeNull()
    expect(cap!.id).toBe('builtin_content_pipeline')
    expect(cap!.name).toBe('内容生产管线')
  })
})
