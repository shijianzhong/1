import Database from 'better-sqlite3'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function defaultSkillsDir() {
  return join(homedir(), 'Library/Application Support', 'one', 'config', 'skills')
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

function collapseWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function fallbackDescription(content) {
  const text = collapseWhitespace(String(content ?? '').replace(/[#>*`_[\]\-]/g, ' '))
  return text.slice(0, 120)
}

function descriptionOf(skill) {
  return collapseWhitespace(skill.description) || fallbackDescription(skill.content)
}

function buildMatchQuery(query) {
  const seg = tokenizeForFts(query)
  const words = seg.split(' ').filter(Boolean)
  const bigrams = words.filter((w) => [...w].length >= 2)
  const terms = (bigrams.length > 0 ? bigrams : words).map((w) => `"${w.replace(/"/g, ' ')}"`)
  return terms.join(' OR ')
}

function loadSkills(skillsDir) {
  if (!existsSync(skillsDir)) {
    throw new Error(`skills dir not found: ${skillsDir}`)
  }
  return readdirSync(skillsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(skillsDir, name), 'utf8')))
}

function createIndex(skills) {
  const db = new Database(':memory:')
  db.exec(`
    CREATE VIRTUAL TABLE skills_fts USING fts5(
      skill_id UNINDEXED,
      name,
      description,
      content_tokenized,
      content_raw UNINDEXED,
      tokenize='unicode61'
    );
  `)
  const ins = db.prepare(
    'INSERT INTO skills_fts (skill_id, name, description, content_tokenized, content_raw) VALUES (?, ?, ?, ?, ?)',
  )
  for (const skill of skills) {
    const desc = descriptionOf(skill)
    ins.run(skill.id, skill.name, desc, tokenizeForFts(`${skill.name} ${desc} ${skill.content}`), skill.content)
  }
  return db
}

function searchSkills(db, keywords, limit = 8) {
  const q = collapseWhitespace(keywords)
  if (!q) return []
  const score = new Map()
  const hit = new Map()
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
      // ignore malformed MATCH edge cases
    }
  }

  const pattern = `%${q}%`
  const likeRows = db.prepare(
    `SELECT skill_id as id, name, description as desc
     FROM skills_fts
     WHERE name LIKE ? OR description LIKE ? OR content_raw LIKE ?
     LIMIT ?`,
  ).all(pattern, pattern, pattern, limit)
  for (const row of likeRows) bump(row, 1)

  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => hit.get(id))
    .filter(Boolean)
}

const CASES = [
  {
    label: '闭环总控',
    query: '帮我做技术公众号内容生产闭环',
    primary: 'wechat-tech-content',
  },
  {
    label: '选题调研-全网',
    query: '帮我做全网技术选题调研',
    primary: 'tech-research',
  },
  {
    label: '选题调研-推荐',
    query: '选 3 个高价值技术选题',
    primary: 'tech-research',
  },
  {
    label: '对标拆解',
    query: '做公众号对标拆解',
    primary: 'content-teardown',
  },
  {
    label: '结构逆向',
    query: '拆解同类技术号标题公式和 6 段式结构',
    primary: 'content-teardown',
  },
  {
    label: '公众号写作',
    query: '按风格模板写一篇技术公众号深度文',
    primary: 'wechat-writing',
    expected: ['wechat-writing', 'wechat-tech-content'],
  },
  {
    label: '写作配图落盘',
    query: '产出公众号初稿并配图落盘',
    primary: 'wechat-writing',
  },
  {
    label: '内容审稿',
    query: '对这篇内容做审稿打分',
    primary: 'content-review',
  },
  {
    label: '质量门禁',
    query: '不通过就返工的内容审稿',
    primary: 'content-review',
  },
  {
    label: '码农号生产',
    query: '给码农知道的事这类技术号生产内容',
    primary: 'wechat-tech-content',
  },
  {
    label: '完整一条龙',
    query: '从选题到写作一条龙做技术公众号',
    primary: 'wechat-tech-content',
  },
  {
    label: '技术公众号写作',
    query: '技术公众号写作',
    primary: 'wechat-writing',
    expected: ['wechat-writing', 'wechat-tech-content'],
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
    '',
    '## 样本技能',
    '',
    '| name | description |',
    '|---|---|',
    ...skills.map((s) => `| \`${s.name}\` | ${descriptionOf(s).replace(/\|/g, '\\|')} |`),
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
    '| 场景 | query | 期望主目标 | Top1 | Top3 | Primary Top1 | Primary Top3 |',
    '|---|---|---|---|---|---|---|',
    ...evaluation.rows.map((row) => {
      const top3 = row.names.slice(0, 3).join(' / ') || '—'
      return `| ${row.label} | ${row.query} | \`${row.primary}\` | \`${row.names[0] ?? '—'}\` | ${top3.replace(/\|/g, '\\|')} | ${row.primaryTop1 ? '✅' : '❌'} | ${row.primaryTop3 ? '✅' : '❌'} |`
    }),
    '',
    '## 错例与观察',
    '',
  ]

  const misses = evaluation.rows.filter((row) => !row.primaryTop1)
  if (misses.length === 0) {
    lines.push('- 本轮没有 Top1 错例。')
  } else {
    for (const miss of misses) {
      lines.push(`- **${miss.label}**：query=\`${miss.query}\``)
      lines.push(`  - 期望：\`${miss.primary}\``)
      lines.push(`  - 实际 Top3：${miss.names.slice(0, 3).map((n) => `\`${n}\``).join(' / ') || '—'}`)
    }
  }

  lines.push('', '## 初步结论', '')
  const strictTop1 = Number(evaluation.summary.primaryTop1.match(/\(([\d.]+)%\)/)?.[1] ?? '0')
  if (strictTop1 >= 80) {
    lines.push('- 当前 `name + description + FTS + LIKE` 方案在这批真实技能上已经可用，主问题不在“完全搜不到”，而在相近技能之间的排序边界。')
  } else {
    lines.push('- 当前检索能用，但 Top1 排序仍有明显优化空间。')
  }
  lines.push('- 由于样本里的 5 个技能高度同域，很多 query 本身存在“闭环 skill”和“子阶段 skill”同时合理的情况，因此同时观察 strict 与 relaxed 指标更有意义。')
  lines.push('- 若后续装入更多跨域 skill，下一轮优先验证不同赛道之间是否会互相误召回。')

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
