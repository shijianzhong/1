import { readdirSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import type { Skill } from '@shared/types'
import { logger } from '../logger'

// —— Skill = ContextProvider（铁律22/23，task 7.4）——
// beforeRun：绑定的 SKILL.md inline 成 <skill> XML 块（限长 24000 字 + 脚本清单）
//            + discipline 输出纪律段拼进 instructions；
//            脚本执行工具 skill_run_script 经全局工具注册表暴露（铁律22「注入工具到
//            agent.tools」在本架构 = 注册进工具注册表，编排/首页 agent 统一 listToolDefs 取）。
// afterRun：运行结束审计日志；per-agent 可变状态存储尚无，留读/改状态扩展点。
// 脚本执行必须 async（铁律23）：实现见 tools/builtin/skillScript.ts
// （spawn + Promise 化，超时/AbortSignal/输出截断纪律复用 opencli_run 趟出的路）。

const SKILL_CONTENT_LIMIT = 24000

export interface InjectedSkillInfo {
  id: string
  name: string
  hasScripts: boolean
  hasDiscipline: boolean
}

/** <skill> XML 块（铁律22）：description + 脚本清单 + 限长截断 */
export function buildSkillXmlBlock(skill: Skill, scripts: string[] = []): string {
  const content =
    skill.content.length > SKILL_CONTENT_LIMIT
      ? skill.content.slice(0, SKILL_CONTENT_LIMIT) + '\n\n[... skill 内容超长截断 ...]'
      : skill.content
  const desc = skill.description ? `\n  description: ${skill.description}` : ''
  const scriptLine =
    scripts.length > 0
      ? `\n  scripts: ${scripts.join(', ')}（用 skill_run_script 工具执行，skill 填 "${skill.name}"，script 填脚本相对路径）`
      : ''
  return `<skill name="${skill.name}"${desc}${scriptLine}>\n${content}\n</skill>`
}

/** discipline → 输出纪律段（无 discipline 返回 null） */
export function buildDisciplineBlock(skill: Skill): string | null {
  const discipline = skill.discipline?.trim()
  if (!discipline) return null
  return `【输出纪律】（技能「${skill.name}」）\n${discipline}`
}

/** 由 scriptPath 向上定位 scripts/ 目录（脚本可能嵌套子目录，scriptPath 记录的是首个脚本文件） */
export function resolveScriptsDir(scriptPath: string): string | null {
  let dir = dirname(scriptPath)
  for (let i = 0; i < 4; i++) {
    if (basename(dir) === 'scripts') return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** 列出技能 scripts/ 目录下全部脚本（相对 scripts/ 的路径，深度限 3）；无脚本/读失败返回 [] */
export function listSkillScripts(skill: Skill): string[] {
  if (!skill.scriptPath) return []
  const scriptsDir = resolveScriptsDir(skill.scriptPath)
  if (!scriptsDir) return []
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else out.push(relative(scriptsDir, full).split(sep).join('/'))
    }
  }
  try {
    walk(scriptsDir, 0)
  } catch (error) {
    logger.warn(`[skill-provider] 读取技能 ${skill.name} 脚本目录失败`, error)
    return []
  }
  return out.sort()
}

export class SkillContextProvider {
  private agentName = ''
  private injected: InjectedSkillInfo[] = []

  constructor(private readonly resolveSkill: (id: string) => Skill | null | undefined) {}

  /**
   * beforeRun（铁律22）：skillIds → instructions 注入。
   * 结构：基础 instructions → <skill> XML 块（含脚本清单）→ 【输出纪律】段。
   * 缺失 skill 跳过并 warn（不阻断运行）。
   */
  beforeRun(input: { agentName: string; skillIds: string[]; instructions: string }): {
    instructions: string
    injected: InjectedSkillInfo[]
  } {
    this.agentName = input.agentName
    const blocks: string[] = []
    const disciplineBlocks: string[] = []
    const injected: InjectedSkillInfo[] = []
    for (const sid of input.skillIds) {
      const skill = this.resolveSkill(sid)
      if (!skill) {
        logger.warn(`[skill-provider] ${input.agentName} 绑定的 skill ${sid} 不存在，跳过`)
        continue
      }
      const scripts = listSkillScripts(skill)
      blocks.push(buildSkillXmlBlock(skill, scripts))
      const discipline = buildDisciplineBlock(skill)
      if (discipline) disciplineBlocks.push(discipline)
      injected.push({
        id: skill.id,
        name: skill.name,
        hasScripts: scripts.length > 0,
        hasDiscipline: discipline !== null,
      })
    }
    this.injected = injected
    const sections = [input.instructions, ...blocks, ...disciplineBlocks].filter(Boolean)
    return { instructions: sections.join('\n\n'), injected }
  }

  /** afterRun：运行结束（含异常/取消）审计；状态读/写扩展点 */
  afterRun(): void {
    if (this.injected.length === 0) return
    logger.info(
      `[skill-provider] ${this.agentName} 本轮注入 ${this.injected.length} 个技能：` +
        this.injected
          .map((s) => `${s.name}${s.hasScripts ? '(含脚本)' : ''}${s.hasDiscipline ? '(含纪律)' : ''}`)
          .join(', '),
    )
  }
}
