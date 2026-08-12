#!/usr/bin/env node
// Skill JSON → 目录化一次性迁移（docs/SKILL_STORAGE_STANDARD_PLAN.md §8.3「明确清空旧世界」）
//
// 现状：config/skills/ 下残留改造前的 *.json（旧 JsonCollection 主存储）。
// 目录化改造后 store.ts 只扫子目录里的 SKILL.md，顶层 JSON 已是死数据，
// 但占磁盘、让人困惑，必须清。本脚本把旧 JSON 转成目录格式或直接删除。
//
// 三类情况：
//   1. JSON 有同名目录（SKILL.md 已存在）→ 目录是真源，删 JSON
//   2. 孤儿 JSON（无目录）且无 scriptPath → 纯文本 skill，建 <id>/SKILL.md，删 JSON
//   3. 孤儿 JSON 且有 scriptPath（指向 skl_upload_* 临时目录）→
//      把临时目录的 scripts/references/assets 搬进 <id>/，写 SKILL.md，删 JSON + 删临时目录
//
// 用法：
//   node scripts/migrate-skills-to-dir.mjs            # dry-run，只打印计划
//   node scripts/migrate-skills-to-dir.mjs --apply    # 真正执行
//
// 幂等：跑完无 JSON 可转，再跑空操作。--apply 失败不回滚单步已完成的（已落盘的目录保留）。

import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync, renameSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'

// —— 极简 SKILL.md 构建（不依赖 TS 别名，与 storage/skills/parser.ts buildSkillMd 同口径）——
function yamlSafe(s) {
  return /[:#\n"'[\]{}]/.test(s) ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : s
}
function buildSkillMd(skill) {
  const fm = ['---', `name: ${yamlSafe(skill.name)}`]
  if (skill.description) fm.push(`description: ${yamlSafe(skill.description)}`)
  if (skill.registry) {
    fm.push(`registry_id: ${skill.registry.registryId}`)
    fm.push(`registry_version: ${skill.registry.version}`)
    if (skill.registry.author) fm.push(`registry_author: ${yamlSafe(skill.registry.author)}`)
    fm.push(`registry_imported_at: ${skill.registry.importedAt}`)
  }
  fm.push('---')
  let body = (skill.content ?? '').trimEnd()
  if (skill.discipline && !extractDisciplineSection(body)) {
    body += `\n\n## Discipline\n\n${String(skill.discipline).trim()}`
  }
  return fm.join('\n') + '\n\n' + body + '\n'
}
function extractDisciplineSection(body) {
  const lines = body.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+discipline\s*$/i.test(lines[i].trim())) { start = i + 1; break }
  }
  if (start === -1) return undefined
  const collected = []
  for (let i = start; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break
    collected.push(lines[i])
  }
  const t = collected.join('\n').trim()
  return t || undefined
}

// —— 路径：与主进程 app.getPath('userData') 同口径（铁律4）——
// 脚本在 Electron 上下文外跑，用 ONE_USER_DATA 覆盖；默认 macOS 路径。
const skillsDir = process.env.ONE_USER_DATA
  ? join(process.env.ONE_USER_DATA, 'config', 'skills')
  : join(process.env.HOME, 'Library', 'Application Support', 'one', 'config', 'skills')

const APPLY = process.argv.includes('--apply')
const log = (...a) => console.log(...a)

function plan() {
  if (!existsSync(skillsDir)) {
    log(`[migrate] skills 目录不存在: ${skillsDir}`)
    return
  }
  const entries = readdirSync(skillsDir, { withFileTypes: true })
  const jsonFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name)
  const dirs = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name))

  // skl_upload_* 临时目录引用计数（被某 JSON 的 scriptPath 指向则保留，否则删）
  const uploadDirRefs = new Map() // dirName -> 引用它的 JSON 文件名
  const actions = [] // {type, desc, run}

  for (const jf of jsonFiles) {
    const id = jf.slice(0, -'.json'.length)
    const jsonPath = join(skillsDir, jf)
    let data
    try {
      data = JSON.parse(readFileSync(jsonPath, 'utf8'))
    } catch (e) {
      actions.push({ type: 'skip', desc: `跳过（JSON 解析失败）: ${jf} — ${e.message}`, run: () => {} })
      continue
    }

    // 情况1：有同名目录 → 目录是真源，删 JSON
    if (dirs.has(id)) {
      const skillMd = join(skillsDir, id, 'SKILL.md')
      if (existsSync(skillMd)) {
        actions.push({
          type: 'delete_paired_json',
          desc: `删配对 JSON（目录已有 SKILL.md）: ${jf}`,
          run: () => rmSync(jsonPath, { force: true }),
        })
      } else {
        // 同名目录存在但无 SKILL.md —— 异常，保守不删，提示
        actions.push({ type: 'skip', desc: `保留 JSON（同名目录无 SKILL.md，需人工核查）: ${jf}`, run: () => {} })
      }
      continue
    }

    // 孤儿 JSON：转目录格式
    const skill = {
      id,
      name: data.name || id,
      description: data.description,
      content: data.content || '',
      discipline: data.discipline,
      registry: data.registry,
    }
    const targetDir = join(skillsDir, id)

    if (!data.scriptPath) {
      // 情况2：无脚本，纯文本
      actions.push({
        type: 'orphan_to_dir',
        desc: `孤儿→目录（纯文本）: ${jf} → ${id}/SKILL.md`,
        run: () => {
          mkdirSync(targetDir, { recursive: true })
          writeFileSync(join(targetDir, 'SKILL.md'), buildSkillMd(skill), 'utf8')
          rmSync(jsonPath, { force: true })
        },
      })
    } else {
      // 情况3：有 scriptPath，指向 skl_upload_* 临时目录
      const sp = data.scriptPath
      const rel = relative(skillsDir, sp)
      const top = rel.split(sep)[0]
      if (rel.startsWith('..') || !top.startsWith('skl_upload_')) {
        actions.push({ type: 'skip', desc: `保留 JSON（scriptPath 不指向 skl_upload_，人工核查）: ${jf} → ${sp}`, run: () => {} })
        continue
      }
      const uploadDir = join(skillsDir, top)
      uploadDirRefs.set(top, jf)
      actions.push({
        type: 'orphan_with_scripts',
        desc: `孤儿→目录（带脚本）: ${jf} + ${top}/ → ${id}/SKILL.md + scripts/refs/assets`,
        run: () => {
          mkdirSync(targetDir, { recursive: true })
          writeFileSync(join(targetDir, 'SKILL.md'), buildSkillMd(skill), 'utf8')
          // 搬 scripts/references/assets（存在则整体移动）
          for (const sub of ['scripts', 'references', 'assets']) {
            const src = join(uploadDir, sub)
            if (existsSync(src)) {
              renameSync(src, join(targetDir, sub))
            }
          }
          rmSync(jsonPath, { force: true })
          // uploadDir 里若只剩空壳则删
          rmSync(uploadDir, { recursive: true, force: true })
        },
      })
    }
  }

  // 情况4：无主 skl_upload_* 临时目录（没有 JSON 的 scriptPath 引用它）→ 删
  for (const d of dirs) {
    if (d.startsWith('skl_upload_') && !uploadDirRefs.has(d)) {
      actions.push({
        type: 'delete_orphan_upload',
        desc: `删无主临时目录: ${d}/`,
        run: () => rmSync(join(skillsDir, d), { recursive: true, force: true }),
      })
    }
  }

  return actions
}

const actions = plan()
if (!actions || actions.length === 0) {
  log('[migrate] 无可迁移项（可能已清理完毕）')
  process.exit(0)
}

log(`[migrate] skillsDir = ${skillsDir}`)
log(`[migrate] 模式 = ${APPLY ? 'APPLY（真执行）' : 'DRY-RUN（只打印，加 --apply 执行）'}`)
log(`[migrate] 共 ${actions.length} 项:`)
actions.forEach((a, i) => log(`  ${String(i + 1).padStart(2)}. [${a.type}] ${a.desc}`))

if (!APPLY) {
  log('\n[migrate] dry-run 结束。确认无误后执行: node scripts/migrate-skills-to-dir.mjs --apply')
  process.exit(0)
}

let ok = 0, fail = 0
for (const a of actions) {
  try {
    a.run()
    ok++
  } catch (e) {
    log(`[migrate] 失败: ${a.desc} — ${e.message}`)
    fail++
  }
}
log(`\n[migrate] 完成: 成功 ${ok}，失败 ${fail}`)
log('[migrate] 提示：下次启动应用时，db.ts 会自检 FTS 行数与目录数不一致并自动重建索引。')
