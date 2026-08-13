import Database from 'better-sqlite3'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function defaultSkillsDir() {
  return join(homedir(), 'Library/Application Support', 'one', 'config', 'skills')
}

function collapseWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function fallbackDescription(content) {
  const text = collapseWhitespace(String(content ?? '').replace(/[#>*`_[\]\-]/g, ' '))
  return text.slice(0, 120)
}

function tokenizeForFts(text) {
  const s = String(text ?? '').toLowerCase()
  const tokens = []
  const re = /[a-z0-9_]+|[^\sa-z0-9_]/g
  let m
  let prevCjk = null
  while ((m = re.exec(s)) !== null) {
    const tok = m[0]
    const isAsciiWord = /^[a-z0-9_]+$/.test(tok)
    if (isAsciiWord) {
      tokens.push(tok)
      prevCjk = null
      continue
    }
    if (/\s/.test(tok)) {
      prevCjk = null
      continue
    }
    tokens.push(tok)
    if (prevCjk) tokens.push(prevCjk + tok)
    prevCjk = tok
  }
  return tokens.join(' ')
}

function parseFrontmatter(text) {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  if (!match) return { fm: null, body: text.trim() }

  const lines = match[1].split('\n')
  const body = match[2].trim()
  const fm = {}

  let i = 0
  while (i < lines.length) {
    const trimmed = lines[i].trim()
    i++
    if (!trimmed || trimmed.startsWith('#')) continue
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx === -1) continue
    const key = trimmed.slice(0, colonIdx).trim()
    let value = trimmed.slice(colonIdx + 1).trim()
    if (!key) continue

    if (value === '|' || value === '>') {
      const folded = value === '>'
      const block = []
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i].startsWith('\t'))) {
        block.push(lines[i].trim())
        i++
      }
      value = folded ? block.join(' ') : block.join('\n')
    } else if (!value) {
      const list = []
      while (i < lines.length && (lines[i].startsWith('  - ') || lines[i].startsWith('\t- '))) {
        list.push(lines[i].replace(/^\s*-\s*/, '').trim())
        i++
      }
      value = list.length > 0 ? list : ''
    } else if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\(["\\])/g, '$1')
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1)
    } else {
      const hashIdx = value.indexOf(' #')
      if (hashIdx !== -1) value = value.slice(0, hashIdx).trim()
    }

    fm[key] = value
  }

  return { fm, body }
}

function parseInlineYamlArray(value) {
  const text = String(value ?? '').trim()
  if (!text.startsWith('[') || !text.endsWith(']')) return null
  const inner = text.slice(1, -1).trim()
  if (!inner) return []

  const items = []
  let current = ''
  let quote = null

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (quote) {
      if (ch === '\\' && i + 1 < inner.length) {
        current += inner[i + 1]
        i++
        continue
      }
      if (ch === quote) {
        quote = null
        continue
      }
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === ',') {
      const item = current.trim()
      if (item) items.push(item)
      current = ''
      continue
    }
    current += ch
  }

  const last = current.trim()
  if (last) items.push(last)
  return items
}

function parseSkillMd(text) {
  const { fm, body } = parseFrontmatter(text)
  const name = typeof fm?.name === 'string' ? fm.name.trim() : ''
  if (!name) return null
  const description = typeof fm?.description === 'string' ? fm.description.trim() : undefined
  const inlineTags = typeof fm?.tags === 'string' ? parseInlineYamlArray(fm.tags) : null
  const tags = Array.isArray(fm?.tags)
    ? fm.tags.map((tag) => String(tag).trim()).filter(Boolean)
    : inlineTags
      ? inlineTags.map((tag) => String(tag).trim()).filter(Boolean)
      : typeof fm?.tags === 'string'
        ? fm.tags.split(',').map((tag) => tag.trim()).filter(Boolean)
        : undefined
  return {
    name,
    description,
    tags,
    content: body,
  }
}

function loadSkills(skillsDir) {
  if (!existsSync(skillsDir)) {
    throw new Error(`skills dir not found: ${skillsDir}`)
  }

  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('skl_upload_'))
    .map((entry) => {
      const skillMdPath = join(skillsDir, entry.name, 'SKILL.md')
      if (!existsSync(skillMdPath)) return null
      const parsed = parseSkillMd(readFileSync(skillMdPath, 'utf8'))
      if (!parsed) return null
      return {
        id: entry.name,
        ...parsed,
      }
    })
    .filter(Boolean)
}

function descriptionOf(skill) {
  return collapseWhitespace(skill.description) || fallbackDescription(skill.content)
}

function tagsTextOf(skill) {
  return (skill.tags ?? []).join(' ')
}

function createIndex(skills) {
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
  const ins = db.prepare(
    'INSERT INTO skills_fts (skill_id, name, description, tags, content_tokenized, content_raw) VALUES (?, ?, ?, ?, ?, ?)',
  )
  for (const skill of skills) {
    const desc = descriptionOf(skill)
    const tagsText = tagsTextOf(skill)
    ins.run(
      skill.id,
      skill.name,
      desc,
      tagsText,
      tokenizeForFts(`${skill.name} ${tagsText} ${desc} ${skill.content}`),
      `${tagsText}\n\n${skill.content}`.trim(),
    )
  }
  return db
}

function buildMatchQuery(query) {
  const seg = tokenizeForFts(query)
  const words = seg.split(' ').filter(Boolean)
  const bigrams = words.filter((w) => [...w].length >= 2)
  const terms = (bigrams.length > 0 ? bigrams : words).map((w) => `"${w.replace(/"/g, ' ')}"`)
  return terms.join(' OR ')
}

function searchSkills(db, keywords, limit = 8) {
  const q = collapseWhitespace(keywords)
  if (!q) return []

  const score = new Map()
  const hit = new Map()
  const pattern = `%${q}%`
  const bump = (row, weight) => {
    hit.set(row.id, row)
    score.set(row.id, (score.get(row.id) ?? 0) + weight)
  }

  const nameRows = db.prepare(
    `SELECT skill_id as id, name, description as desc
     FROM skills_fts
     WHERE name = ? OR name LIKE ?
     LIMIT ?`,
  ).all(q, `${q}%`, limit)
  for (const row of nameRows) bump(row, 3)

  const tagRows = db.prepare(
    `SELECT skill_id as id, name, description as desc
     FROM skills_fts
     WHERE tags = ? OR tags LIKE ?
     LIMIT ?`,
  ).all(q, pattern, limit)
  for (const row of tagRows) bump(row, 2.5)

  const match = buildMatchQuery(q)
  if (match) {
    try {
      const rows = db.prepare(
        `SELECT skill_id as id, name, description as desc, rank
         FROM skills_fts
         WHERE skills_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      ).all(match, limit)
      rows.forEach((row, index) => bump(row, 2 - index * (1 / Math.max(1, rows.length))))
    } catch {
      // 忽略极端 query 导致的 MATCH 语法边界
    }
  }

  const likeRows = db.prepare(
    `SELECT skill_id as id, name, description as desc
     FROM skills_fts
     WHERE name LIKE ? OR description LIKE ? OR tags LIKE ? OR content_raw LIKE ?
     LIMIT ?`,
  ).all(pattern, pattern, pattern, pattern, limit)
  for (const row of likeRows) bump(row, 1)

  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => hit.get(id))
    .filter(Boolean)
}

const CASES = [
  {
    label: '公众号闭环',
    query: '帮我做技术公众号内容生产闭环',
    primary: 'wechat-tech-content',
    expected: ['wechat-tech-content'],
  },
  {
    label: '选题调研',
    query: '帮我做全网技术选题调研，给 3 个高价值方向',
    primary: 'tech-research',
    expected: ['tech-research', 'agent-reach'],
  },
  {
    label: '对标拆解',
    query: '拆解 3 个同类技术号的标题公式和结构套路',
    primary: 'content-teardown',
    expected: ['content-teardown'],
  },
  {
    label: '公众号写作',
    query: '按技术号风格模板写一篇微信公众号深度文',
    primary: 'wechat-writing',
    expected: ['wechat-writing', 'wechat-tech-content'],
  },
  {
    label: '内容审稿',
    query: '对这篇文章做审稿打分，不通过就返工',
    primary: 'content-review',
    expected: ['content-review'],
  },
  {
    label: '公众号排版',
    query: '把 Markdown 转成公众号 HTML',
    primary: 'md2wechat',
    expected: ['md2wechat', 'baoyu-post-to-wechat'],
  },
  {
    label: '发布公众号',
    query: '把这篇文章发布到微信公众号草稿箱',
    primary: 'baoyu-post-to-wechat',
    expected: ['baoyu-post-to-wechat', 'md2wechat'],
  },
  {
    label: '品牌手册',
    query: '帮我做一个高端品牌手册和视觉规范板',
    primary: 'brandkit',
    expected: ['brandkit', 'brand-guidelines'],
  },
  {
    label: '前端重设计',
    query: '重做现有网站，让质感更高级但不破坏功能',
    primary: 'redesign-existing-projects',
    expected: ['redesign-existing-projects', 'design-taste-frontend', 'impeccable'],
  },
  {
    label: '设计审美增强',
    query: '把这个前端界面打磨得更有设计感',
    primary: 'impeccable',
    expected: ['impeccable', 'design-taste-frontend', 'high-end-visual-design'],
  },
  {
    label: '飞书文档',
    query: '帮我创建飞书文档并插入图片',
    primary: 'lark-doc',
    expected: ['lark-doc'],
  },
  {
    label: '飞书联系人',
    query: '查一下同事的 open_id 和联系方式',
    primary: 'lark-contact',
    expected: ['lark-contact'],
  },
  {
    label: '日程待办摘要',
    query: '生成一份今天的日程和待办摘要',
    primary: 'lark-workflow-standup-report',
    expected: ['lark-workflow-standup-report', 'lark-calendar', 'lark-task'],
  },
  {
    label: '创建日程',
    query: '帮我在飞书日历里创建一个明天下午的会议',
    primary: 'lark-calendar',
    expected: ['lark-calendar'],
  },
  {
    label: '电子表格',
    query: '创建一个飞书电子表格并写入表头和数据',
    primary: 'lark-sheets',
    expected: ['lark-sheets'],
  },
  {
    label: '会议纪要汇总',
    query: '整理本周会议纪要并生成结构化周报',
    primary: 'lark-workflow-meeting-summary',
    expected: ['lark-workflow-meeting-summary', 'lark-vc'],
  },
  {
    label: 'X 作战计划',
    query: '帮我做一个 X 账号内容作战计划 PDF',
    primary: 'dashen-x-battle-plan',
    expected: ['dashen-x-battle-plan'],
  },
  {
    label: 'Vue 脚手架',
    query: '做一个 Vue 3 脚手架项目',
    primary: 'vue-init',
    expected: ['vue-init'],
  },
  {
    label: 'Web 测试',
    query: '帮我测试本地 web 应用页面交互',
    primary: 'webapp-testing',
    expected: ['webapp-testing', 'webapp-quality-gate'],
  },
  {
    label: 'GitHub 知识库',
    query: '帮我建立一个 GitHub 仓库知识库并支持搜索',
    primary: 'github-kb',
    expected: ['github-kb'],
  },
  {
    label: '创建 Skill',
    query: '帮我创建一个新的 agent skill',
    primary: 'skill-creator',
    expected: ['skill-creator'],
  },
  {
    label: '找 Skill',
    query: '帮我找一个能完成这个任务的 skill',
    primary: 'find-skills',
    expected: ['find-skills'],
  },
]

function evaluate(db) {
  const rows = CASES.map((testCase) => {
    const results = searchSkills(db, testCase.query, 5)
    const names = results.map((r) => r.name)
    const expected = testCase.expected ?? [testCase.primary]
    const primaryRank = names.indexOf(testCase.primary)
    const relaxedRank = names.findIndex((name) => expected.includes(name))
    return {
      ...testCase,
      expected,
      results,
      names,
      primaryTop1: primaryRank === 0,
      primaryTop3: primaryRank >= 0 && primaryRank < 3,
      primaryTop5: primaryRank >= 0 && primaryRank < 5,
      relaxedTop1: relaxedRank === 0,
      relaxedTop3: relaxedRank >= 0 && relaxedRank < 3,
      relaxedTop5: relaxedRank >= 0 && relaxedRank < 5,
    }
  })
  const ratio = (value) => `${value}/${rows.length} (${((value / rows.length) * 100).toFixed(1)}%)`
  const summary = {
    caseCount: rows.length,
    primaryTop1: ratio(rows.filter((r) => r.primaryTop1).length),
    primaryTop3: ratio(rows.filter((r) => r.primaryTop3).length),
    primaryTop5: ratio(rows.filter((r) => r.primaryTop5).length),
    relaxedTop1: ratio(rows.filter((r) => r.relaxedTop1).length),
    relaxedTop3: ratio(rows.filter((r) => r.relaxedTop3).length),
    relaxedTop5: ratio(rows.filter((r) => r.relaxedTop5).length),
  }
  return { rows, summary }
}

function toMarkdown(skills, evaluation, skillsDir) {
  const date = new Date().toISOString().slice(0, 10)
  const lines = [
    '# Skill RAG 召回验证',
    '',
    `- 日期：${date}`,
    `- 样本来源：\`${skillsDir}\``,
    `- skill 数量：${skills.length}`,
    `- 评测 query 数量：${evaluation.summary.caseCount}`,
    `- 当前口径：**离线检索层评测**（对应主 agent 的 \`skill_search\` 能力），不含真实 LLM 是否主动调用工具的端到端行为。`,
    '',
    '## 指标',
    '',
    '| 指标 | 结果 |',
    '|---|---|',
    `| Primary Top1 | ${evaluation.summary.primaryTop1} |`,
    `| Primary Top3 | ${evaluation.summary.primaryTop3} |`,
    `| Primary Top5 | ${evaluation.summary.primaryTop5} |`,
    `| Relaxed Top1 | ${evaluation.summary.relaxedTop1} |`,
    `| Relaxed Top3 | ${evaluation.summary.relaxedTop3} |`,
    `| Relaxed Top5 | ${evaluation.summary.relaxedTop5} |`,
    '',
    '## 明细',
    '',
    '| 场景 | query | 期望主目标 | Top1 | Top3 | Primary Top1 | Relaxed Top3 |',
    '|---|---|---|---|---|---|---|',
    ...evaluation.rows.map((row) => {
      const top3 = row.names.slice(0, 3).join(' / ') || '—'
      return `| ${row.label} | ${row.query} | \`${row.primary}\` | \`${row.names[0] ?? '—'}\` | ${top3.replace(/\|/g, '\\|')} | ${row.primaryTop1 ? '✅' : '❌'} | ${row.relaxedTop3 ? '✅' : '❌'} |`
    }),
    '',
    '## 错例与观察',
    '',
  ]

  const strictMisses = evaluation.rows.filter((row) => !row.primaryTop1)
  if (strictMisses.length === 0) {
    lines.push('- 本轮没有 Top1 错例。')
  } else {
    for (const miss of strictMisses) {
      lines.push(`- **${miss.label}**：query=\`${miss.query}\``)
      lines.push(`  - 期望主目标：\`${miss.primary}\``)
      lines.push(`  - 可接受目标：${miss.expected.map((name) => `\`${name}\``).join(' / ')}`)
      lines.push(`  - 实际 Top3：${miss.names.slice(0, 3).map((n) => `\`${n}\``).join(' / ') || '—'}`)
    }
  }

  const strictTop1 = Number(evaluation.summary.primaryTop1.match(/\(([\d.]+)%\)/)?.[1] ?? '0')
  lines.push('', '## 初步结论', '')
  if (strictTop1 >= 80) {
    lines.push('- 当前检索层已经可用，主要风险在相近 skill 之间的排序边界。')
  } else if (strictTop1 >= 60) {
    lines.push('- 当前检索层可用但不稳，主 agent 自动召回存在明显误召回风险，尤其在同域多 skill 场景。')
  } else {
    lines.push('- 当前检索层已不足以支撑稳定的主 agent 自动召回；在真实任务里，即使主 agent 愿意调用 `skill_search`，也很可能先拿到错误 skill。')
  }
  lines.push('- 本轮 skill 池已经从早期少量闭环 skill 扩展到 60+，旧评测口径不再成立，必须按当前目录化 skill 池重新评估。')
  lines.push('- 如果离线检索层已经错位，主 agent 端到端自动召回只会更差，因为还叠加了一层“模型是否会主动搜 / 会不会 load 对”的不确定性。')
  lines.push('- 下一步优先级建议：先修 `skill_search` 的召回与排序，再补真实主 agent 跑批验证。')

  return lines.join('\n')
}

function main() {
  const skillsDir = process.argv[2] || defaultSkillsDir()
  const skills = loadSkills(skillsDir)
  const db = createIndex(skills)
  const evaluation = evaluate(db)
  const markdown = toMarkdown(skills, evaluation, skillsDir)
  process.stdout.write(markdown)
}

main()
