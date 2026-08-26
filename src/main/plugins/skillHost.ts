// —— SkillHostManager（docs/PLUGIN_ARCHITECTURE.md §5 Stage 2 文档空白补齐）——
//
// 文档把所有 kind 启停写成"走 onLoad/onUnload"，但 SkillContextProvider 定死不走那两钩子
//（per-run `new`，构造参数注入 host）。Skill 启停的真实语义是 **skillIds 过滤**：
// enabled=false 的 skill 不进 SkillContextProvider.beforeRun 的 skillIds →
// 不被 inline 成 <skill> XML 块注入。本管理器负责维护 disabledSkills 集合 +
// 提供 filterSkillIds，供 home.ts 三处 call site（:335 / :525）包裹 skillIds。
//
// 启停=改 SKILL.md frontmatter enabled + invalidateSkillsCache + 更新 set。
// onLoad（启动时）扫一遍所有 skill 收集 disabled；toggle 时增量更新。

import { listSkills, setSkillEnabled, invalidateSkillsCache } from '../storage/skills/store'
import type { PluginHost, PluginLifecycle } from './contracts'
import { logger } from '../logger'

class SkillHostManager implements PluginLifecycle {
  /** disabled skill id 集合（enabled=false 的 skill 不注入 beforeRun） */
  private disabledSkills = new Set<string>()

  async onLoad(_ctx: PluginHost): Promise<void> {
    this.refreshDisabledSet()
    logger.info(`[skill-host] 启动扫描完成：${this.disabledSkills.size} 个 skill 禁用`)
  }

  async onUnload(_reason: 'disable' | 'uninstall' | 'shutdown'): Promise<void> {
    // skill-host 是进程级管理器，不随单个插件卸载清空（shutdown 时自然随进程消亡）
    this.disabledSkills.clear()
  }

  /** 重新扫描全部 skill，重建 disabledSkills 集合（启动 + 外部改写后用） */
  refreshDisabledSet(): void {
    const next = new Set<string>()
    for (const skill of listSkills()) {
      if (skill.enabled === false) next.add(skill.id)
    }
    this.disabledSkills = next
  }

  /**
   * 过滤 skillIds：剔除 disabled 的 skill。
   * 供 home.ts 三处 call site 在传 skillIds 给 SkillContextProvider.beforeRun 前调用。
   * SkillContextProvider 签名不变（收到的 skillIds 已过滤）。
   */
  filterSkillIds(skillIds: string[]): string[] {
    if (this.disabledSkills.size === 0) return skillIds
    return skillIds.filter((id) => !this.disabledSkills.has(id))
  }

  /** 禁用某 skill（改 frontmatter + 缓存失效 + 更新 set） */
  async disableSkill(id: string): Promise<void> {
    const updated = setSkillEnabled(id, false)
    invalidateSkillsCache()
    if (updated) this.disabledSkills.add(id)
    logger.info(`[skill-host] 禁用 skill ${id}`)
  }

  /** 启用某 skill（改 frontmatter + 缓存失效 + 更新 set） */
  async enableSkill(id: string): Promise<void> {
    setSkillEnabled(id, true)
    invalidateSkillsCache()
    this.disabledSkills.delete(id)
    logger.info(`[skill-host] 启用 skill ${id}`)
  }

  /** 查询某 skill 是否被禁用（供 /plugins 页 / 诊断用） */
  isDisabled(id: string): boolean {
    return this.disabledSkills.has(id)
  }
}

/** 全局单例 skill-host 管理器（进程级，跨运行稳定） */
export const skillHostManager = new SkillHostManager()
