import { existsSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { Skill } from '@shared/types'
import { logger } from '../logger'
import { getSkillsPath } from '../storage/paths'
import type { PluginHost } from '../plugins/contracts'

// —— Skill = ContextProvider（铁律22/23，task 7.4）——
// beforeRun：绑定的 SKILL.md inline 成 <skill> XML 块（限长 24000 字 + 脚本清单）
//            + discipline 输出纪律段拼进 instructions；
//            脚本执行工具 skill_run_script 经全局工具注册表暴露（铁律22「注入工具到
//            agent.tools」在本架构 = 注册进工具注册表，编排/首页 agent 统一 listToolDefs 取）。
// afterRun：运行结束审计日志；per-agent 可变状态存储尚无，留读/改状态扩展点。
// 脚本执行必须 async（铁律23）：实现见 tools/builtin/skillScript.ts
// （spawn + Promise 化，超时/AbortSignal/输出截断纪律复用 opencli_run 趟出的路）。
//
// 目录化改造（docs/SKILL_STORAGE_STANDARD_PLAN.md §5.2）：
// 删除 scriptPath → resolveScriptsDir 链路，改用 skill id → rootDir → scripts/ 直连。

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

/** 由 skill id 获取根目录（config/skills/<id>） */
export function getSkillRootDir(skillId: string): string {
  return join(getSkillsPath(), skillId)
}

/** 列出技能 scripts/ 目录下全部脚本（相对 scripts/ 的路径，深度限 3）；无脚本/读失败返回 [] */
export function listSkillScripts(rootDir: string): string[] {
  const scriptsDir = join(rootDir, 'scripts')
  if (!existsSync(scriptsDir)) return []
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
    logger.warn(`[skill-provider] 读取脚本目录失败 rootDir=${rootDir}`, error)
    return []
  }
  return out.sort()
}

export class SkillContextProvider {
  private agentName = ''
  private injected: InjectedSkillInfo[] = []

  // host 经构造参数注入（docs/PLUGIN_ARCHITECTURE.md §3「注入方式定死」选 A）：
  // beforeRun/afterRun 签名不变，内部经 this.host 访问 host 能力。
  constructor(
    private readonly resolveSkill: (id: string) => Skill | null | undefined,
    private readonly host: PluginHost,
  ) {}

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
      const scripts = listSkillScripts(getSkillRootDir(skill.id))
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
    // 经构造注入的 host 发射运行事实（插件可订阅，见 PluginEventMap.'skill.injected'）
    this.host.events.emit('skill.injected', {
      agentName: this.agentName,
      skills: this.injected.map((s) => s.id),
    })
  }
}
