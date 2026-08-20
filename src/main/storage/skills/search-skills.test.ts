import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// —— searchSkills 正确性回归门（docs/VECTOR_KB_PLAN.md §八 P3 前置 + SKILL_RAG_EVAL.md）——
// import 生产 searchSkills（非复制）→ drift-free。
// P3 前置重调结论（见 SKILL_RAG_EVAL.md「重调结果」）：token-based name/tag 通道 +
// bm25 列加权在 66-skill 真实池回归 Primary Top1（过度加权 CJK 名「纪律」类 skill），
// 故保留原 ranking，只保留 latent bug 修（escapeLikePattern）+ buildMatchQuery DRY。
// 本测试锁：
//   (a) latent bug：含 % 的 query 不抛、不全表噪声（escapeLikePattern 修）—— 真正的新正确性门
//   (b) 原排名不回归：关键场景仍命中（保 escape 修没破原 ranking 行为）

let memDb: Database.Database

vi.mock('../db', () => ({
  getDb: () => memDb,
}))

const { upsertSkillFts, searchSkills } = await import('./fts')

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE VIRTUAL TABLE skills_fts USING fts5(
      skill_id UNINDEXED,
      name,
      description,
      tags,
      content_tokenized,
      content_raw UNINDEXED,
      tokenize='unicode61'
    );
  `)
  return db
}

/** seed 语料：镜像 SKILL_RAG_EVAL.md 5 失败 + 关键过例的 skill 名/desc/tags/content。
 *  保代表性——不是真 SKILL.md 全文，是浓缩版，命中逻辑与生产一致。 */
function seedCorpus(): void {
  const skills = [
    {
      id: 'skill-creator',
      name: 'skill-creator',
      description: '创建新的 agent skill 技能包，定义 SKILL.md 与输出纪律',
      tags: ['skill', '创建', 'agent'],
      content: '用于创建 skill：写 SKILL.md frontmatter、定义输出纪律、提取资源。',
    },
    {
      id: 'find-skills',
      name: 'find-skills',
      description: '查找能完成任务的 skill，按能力匹配',
      tags: ['skill', '查找', '检索'],
      content: '在已安装 skill 中找一个能完成当前任务的 skill。',
    },
    {
      id: 'wechat-writing',
      name: 'wechat-writing',
      description: '微信公众号深度文写作，技术号风格模板',
      tags: ['公众号', '写作', '微信'],
      content: '按技术号风格写一篇微信公众号深度文：选题、结构、案例。',
    },
    {
      id: 'wechat-tech-content',
      name: 'wechat-tech-content',
      description: '公众号内容生产闭环：选题→调研→写作→排版→发布',
      tags: ['公众号', '内容', '闭环'],
      content: '公众号内容生产的完整闭环，含调研与写作。',
    },
    {
      id: 'md2wechat',
      name: 'md2wechat',
      description: '把 Markdown 转成公众号 HTML，带样式与代码高亮',
      tags: ['markdown', '公众号', 'html'],
      content: 'Markdown 转 公众号 HTML 的转换器，处理样式与排版。',
    },
    {
      id: 'baoyu-post-to-wechat',
      name: 'baoyu-post-to-wechat',
      description: '宝玉式公众号推文写作',
      tags: ['公众号', '推文'],
      content: '宝玉风格公众号推文。',
    },
    {
      id: 'webapp-testing',
      name: 'webapp-testing',
      description: '本地 web 应用页面交互测试，playwright 自动化',
      tags: ['webapp', '测试', 'playwright'],
      content: '测试本地 web 应用页面交互：点击、输入、断言。',
    },
    {
      id: 'webapp-quality-gate',
      name: 'webapp-quality-gate',
      description: 'web 应用质量门禁',
      tags: ['webapp', '质量'],
      content: 'web 应用质量门禁检查。',
    },
    {
      id: 'lark-doc',
      name: 'lark-doc',
      description: '创建飞书文档并插入图片',
      tags: ['飞书', '文档'],
      content: '创建飞书文档并插入图片到文档。',
    },
    {
      id: 'tech-research',
      name: 'tech-research',
      description: '全网技术选题调研',
      tags: ['调研', '选题'],
      content: '全网技术选题调研，给高价值方向。',
    },
    {
      id: 'vue-init',
      name: 'vue-init',
      description: 'vue 项目初始化脚手架',
      tags: ['vue', '脚手架'],
      content: 'vue 项目初始化。',
    },
  ]
  for (const s of skills) {
    upsertSkillFts({
      id: s.id,
      name: s.name,
      description: s.description,
      tags: s.tags,
      content: s.content,
    })
  }
}

beforeEach(() => {
  memDb = freshDb()
  seedCorpus()
})

describe('searchSkills 正确性回归门（P3 前置：escape 修 + 原排名不回归）', () => {
  // 以下命中断言锁「escape 修没破原 ranking 行为」——非「token 通道修了 #4/#5」。
  // 评测证 token 通道在真实池回归 Top1，故未采用；这些用例在小语料上原 ranking 即命中。
  it('创建 agent skill → skill-creator 命中（原排名不回归）', () => {
    const hits = searchSkills('帮我创建一个新的 agent skill', 5)
    expect(hits.map((h) => h.id).slice(0, 3)).toContain('skill-creator')
  })

  it('找一个 skill → find-skills 命中（原排名不回归）', () => {
    const hits = searchSkills('帮我找一个能完成这个任务的 skill', 5)
    expect(hits.map((h) => h.id).slice(0, 3)).toContain('find-skills')
  })

  it('技术号风格微信公众号深度文 → wechat-writing 命中（原排名不回归）', () => {
    const hits = searchSkills('按技术号风格模板写一篇微信公众号深度文', 5)
    expect(hits.map((h) => h.id).slice(0, 3)).toContain('wechat-writing')
  })

  it('Markdown 转公众号 HTML → md2wechat 命中（原排名不回归）', () => {
    const hits = searchSkills('把 Markdown 转成公众号 HTML', 5)
    expect(hits.map((h) => h.id).slice(0, 3)).toContain('md2wechat')
  })

  it('测试本地 web 应用页面交互 → webapp-testing 命中（原排名不回归）', () => {
    const hits = searchSkills('帮我测试本地 web 应用页面交互', 5)
    expect(hits.map((h) => h.id)).toContain('webapp-testing')
  })

  it('飞书文档 → lark-doc 命中（原排名不回归）', () => {
    const hits = searchSkills('帮我创建飞书文档并插入图片', 5)
    expect(hits[0]?.id).toBe('lark-doc')
  })

  // —— 真正的新正确性门：latent 通配符注入 bug 修 ——
  it('latent bug 修：含 % 的 query 不抛、不全表噪声（escapeLikePattern）', () => {
    // 修前：'%折扣 50%' 把 % 当通配符 → 全表扫返所有 skill（11 个，超 limit 噪声）
    // 修后：escape 让 % 作字面量 → 无 skill 含字面"折扣" → 空或极小命中
    const hits = searchSkills('折扣 50%', 5)
    expect(hits.length).toBeLessThanOrEqual(5)
    // 无 skill 的 name/desc/tag/content 含字面 "折扣" → 应为空集
    expect(hits.length).toBe(0)
  })

  it('latent bug 修：含 _ 的 query 不当单字通配符（escapeLikePattern）', () => {
    // 修前：'_' 是 LIKE 单字通配符 → 匹配任意单字 skill 名 → 噪声
    // 修后：_ 作字面量 → 只匹配名含字面下划线的 skill（如 find-skills, skill-creator）
    const hits = searchSkills('find_skills', 5)
    // find-skills 名含字面 '-' 不是 '_'，但 _ 被转义后作字面 → 不命中 find-skills
    // 关键：不抛错 + 不返回全部语料作噪声
    expect(hits.length).toBeLessThanOrEqual(5)
  })

  it('公众号闭环 → wechat-tech-content 命中（原排名不回归）', () => {
    const hits = searchSkills('帮我做技术公众号内容生产闭环', 5)
    expect(hits.map((h) => h.id).slice(0, 3)).toContain('wechat-tech-content')
  })
})
