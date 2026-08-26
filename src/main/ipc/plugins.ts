// —— 插件管理 IPC（docs/PLUGIN_ARCHITECTURE.md §5 Stage 2 /plugins 页）——
// 只读视图 plugins:list → OnePluginManifest[]（从 generated 持久化 + skill-host 读，不另起注册表），
// 写操作 plugins:enable/disable/uninstall（调 GeneratedPlugin 生命周期钩子 / skillHostManager）。
// 经 withHandler 包装，返回 IpcResult<T>（§11.3）。

import { withHandler } from './handler'
import { pluginHost } from '../plugins/host'
import {
  disableGeneratedPlugin,
  enableGeneratedPlugin,
  listGeneratedPluginsForApi,
  loadGeneratedPluginManifest,
  uninstallGeneratedPlugin,
} from '../plugins/generated'
import { skillHostManager } from '../plugins/skillHost'
import { listSkills, setSkillEnabled, invalidateSkillsCache } from '../storage/skills/store'
import type { OnePluginManifest } from '../plugins/contracts'
import type { Skill } from '@shared/types'

/** 把 skill 投影成 OnePluginManifest（统一 /plugins 视图，Stage 2 同展示 skill 启停） */
function skillToManifest(skill: Skill): OnePluginManifest {
  return {
    id: `skill/${skill.id}`,
    kind: 'skill',
    name: skill.name,
    version: '0.1.0',
    description: skill.description ?? '',
    enabled: skill.enabled !== false,
    source: 'skill',
    effects: {
      // skill 不注册工具名前缀（它是 ContextProvider 注入，非 registry 工具）
      tools: [],
      storage: [],
    },
  }
}

export function registerPluginsHandlers(): void {
  // —— 列出全部插件（generated + skill，统一 OnePluginManifest 视图）——
  withHandler<OnePluginManifest[]>('plugins:list', () => {
    // generated 条目 id 加 'generated/' 命名空间前缀（与 types.ts OnePluginManifest 契约一致），
    // 供 UI 回传时据此路由；存储层内部始终用 bare id。
    const generated = listGeneratedPluginsForApi().map((m) => ({ ...m, id: `generated/${m.id}` }))
    const skills = listSkills().map(skillToManifest)
    return [...generated, ...skills]
  })

  // —— 单个插件详情（generated 可展开看 manifest）——
  withHandler<OnePluginManifest | null>('plugins:get', (_e, input) => {
    const { id } = input as { id: string }
    // generated/<id> → 剥前缀转 bare 再查存储层，返回时重新加前缀保持回传一致
    if (id.startsWith('generated/')) {
      const bare = id.slice('generated/'.length)
      const m = loadGeneratedPluginManifest(bare)
      return m ? { ...m, id: `generated/${m.id}` } : null
    }
    // skill/<id>
    if (id.startsWith('skill/')) {
      const skillId = id.slice('skill/'.length)
      const skill = listSkills().find((s) => s.id === skillId)
      return skill ? skillToManifest(skill) : null
    }
    return null
  })

  // —— 启用插件（generated: onLoad 注册；skill: 改 frontmatter enabled）——
  withHandler<void>('plugins:enable', async (_e, input) => {
    const { id } = input as { id: string }
    if (id.startsWith('generated/')) {
      await enableGeneratedPlugin(pluginHost, id.slice('generated/'.length))
    } else if (id.startsWith('skill/')) {
      const skillId = id.slice('skill/'.length)
      await skillHostManager.enableSkill(skillId)
    } else {
      throw new Error(`unknown plugin id: ${id}`)
    }
  })

  // —— 禁用插件（generated: onUnload 回滚；skill: 改 frontmatter enabled）——
  withHandler<void>('plugins:disable', async (_e, input) => {
    const { id } = input as { id: string }
    if (id.startsWith('generated/')) {
      await disableGeneratedPlugin(id.slice('generated/'.length))
    } else if (id.startsWith('skill/')) {
      const skillId = id.slice('skill/'.length)
      await skillHostManager.disableSkill(skillId)
    } else {
      throw new Error(`unknown plugin id: ${id}`)
    }
  })

  // —— 卸载插件（generated: onUnload + 删目录；skill: 暂只禁用，删 skill 走 skills:remove）——
  withHandler<void>('plugins:uninstall', async (_e, input) => {
    const { id } = input as { id: string }
    if (id.startsWith('generated/')) {
      await uninstallGeneratedPlugin(id.slice('generated/'.length))
    } else if (id.startsWith('skill/')) {
      // skill 卸载 = 禁用（删除走 skills:remove，避免 /plugins 误删用户技能内容）
      const skillId = id.slice('skill/'.length)
      setSkillEnabled(skillId, false)
      invalidateSkillsCache()
      skillHostManager.refreshDisabledSet()
    } else {
      throw new Error(`unknown plugin id: ${id}`)
    }
  })
}
