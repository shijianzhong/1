import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseSkillZip } from './upload'
import { extractDisciplineSection } from '../storage/skills/parser'

// —— parseSkillZip discipline 提取（docs/REGISTRY_PLAN.md §1.3）——
// frontmatter `discipline` 优先；缺省回退正文 `## Discipline` 段落；都没有则 undefined。

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'one-skill-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function makeZip(skillMd: string, name = 'skill.zip'): Promise<string> {
  const zip = new AdmZip()
  zip.addFile('SKILL.md', Buffer.from(skillMd, 'utf8'))
  const filePath = join(dir, name)
  await writeFile(filePath, zip.toBuffer())
  return filePath
}

describe('extractDisciplineSection', () => {
  it('提取 ## Discipline 段落到下一个二级标题为止', () => {
    const body = '# Skill\n\n## Discipline\n\n≤300字。\n不要杜撰。\n\n## Usage\n\n用法说明。'
    expect(extractDisciplineSection(body)).toBe('≤300字。\n不要杜撰。')
  })

  it('段落到文末结束', () => {
    const body = '# Skill\n\n## Discipline\n\n保持简洁。'
    expect(extractDisciplineSection(body)).toBe('保持简洁。')
  })

  it('大小写不敏感；无段落返回 undefined', () => {
    expect(extractDisciplineSection('## DISCIPLINE\n\nx')).toBe('x')
    expect(extractDisciplineSection('# No section here')).toBeUndefined()
    expect(extractDisciplineSection('### Discipline\n\nx')).toBeUndefined() // 三级标题不算
  })
})

describe('parseSkillZip discipline', () => {
  it('frontmatter discipline 优先于正文段落', async () => {
    const md = '---\nname: demo\ndiscipline: frontmatter 纪律\n---\n# Demo\n\n## Discipline\n\n正文纪律。'
    const parsed = await parseSkillZip(await makeZip(md))
    expect(parsed.discipline).toBe('frontmatter 纪律')
  })

  it('无 frontmatter 时回退 ## Discipline 段落', async () => {
    const md = '---\nname: demo\n---\n# Demo\n\n## Discipline\n\n≤500字。'
    const parsed = await parseSkillZip(await makeZip(md))
    expect(parsed.discipline).toBe('≤500字。')
  })

  it('都没有时 discipline 为 undefined', async () => {
    const parsed = await parseSkillZip(await makeZip('---\nname: demo\n---\n# Demo'))
    expect(parsed.discipline).toBeUndefined()
  })

  it('content 保持完整（不剥离 Discipline 段，7.4 前 content 是唯一注入载体）', async () => {
    const md = '# Demo\n\n## Discipline\n\n保持简洁。'
    const parsed = await parseSkillZip(await makeZip(md))
    expect(parsed.content).toContain('## Discipline')
    expect(parsed.discipline).toBe('保持简洁。')
  })
})

describe('parseSkillZip frontmatter 引号（与 serialize.yamlSafe 回环，REGISTRY_REVIEW P2）', () => {
  it('双引号包裹值去引号 + 反转义，冒号/井号保真', async () => {
    const md = '---\nname: "Code: Reviewer"\ndescription: "含 # 注释与 \\"引号\\""\n---\n# Demo'
    const parsed = await parseSkillZip(await makeZip(md))
    expect(parsed.name).toBe('Code: Reviewer')
    expect(parsed.description).toBe('含 # 注释与 "引号"')
  })

  it('无引号值含 " #" 仍按行内注释截断（既有行为不变）', async () => {
    const md = '---\nname: demo # 这是注释\n---\n# Demo'
    const parsed = await parseSkillZip(await makeZip(md))
    expect(parsed.name).toBe('demo')
  })
})
