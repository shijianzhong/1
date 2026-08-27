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
import {
  disableGeneratedBPlugin,
  enableGeneratedBPlugin,
  listGeneratedBPluginsForApi,
  loadGeneratedBPluginManifest,
  trustGeneratedBPlugin,
  uninstallGeneratedBPlugin,
} from '../plugins/generatedB'
import {
  disableExternalPlugin,
  enableExternalPlugin,
  listExternalPluginsForApi,
  loadExternalPluginManifest,
  trustExternalPlugin,
  uninstallExternalPlugin,
  setTrustedExternalPlugin,
} from '../plugins/external'
import { skillHostManager } from '../plugins/skillHost'
import { loadMcpConfig } from '../tools/mcp/config'
import { listBuiltinToolDefs } from '../tools/registry'
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

/** 解析 configSchema 里 secret 字段的密钥绑定状态（vaultKeyId 在 vault 中是否存在），注入 transient secretBound 供 /plugins 页标"未绑定密钥"。vault 缺失/查询异常一律按未绑定处理（fail-safe）。 */
async function withSecretBound(m: OnePluginManifest): Promise<OnePluginManifest> {
  if (!m.configSchema || m.configSchema.length === 0) return m
  const secrets = pluginHost.secrets
  const configSchema = await Promise.all(
    m.configSchema.map(async (f) => {
      if (!f.secret || !f.vaultKeyId) return f
      let bound = false
      try {
        bound = (await secrets?.get(f.vaultKeyId)) != null
      } catch {
        bound = false
      }
      return { ...f, secretBound: bound }
    }),
  )
  return { ...m, configSchema }
}

export function registerPluginsHandlers(): void {
  // —— 列出全部插件（generated/A + generated/B + skill，统一 OnePluginManifest 视图）——
  withHandler<OnePluginManifest[]>('plugins:list', async () => {
    // generated 条目 id 加 'generated/' 命名空间前缀（与 types.ts OnePluginManifest 契约一致），
    // 供 UI 回传时据此路由；存储层内部始终用 bare id。
    const generated = listGeneratedPluginsForApi().map((m) => ({ ...m, id: `generated/${m.id}` }))
    const generatedB = await Promise.all(
      listGeneratedBPluginsForApi().map(async (m) => ({
        ...(await withSecretBound(m)),
        id: `generated_b/${m.id}`,
      })),
    )
    const external = await Promise.all(
      listExternalPluginsForApi().map(async (m) => ({
        ...(await withSecretBound(m)),
        id: `external/${m.id}`,
      })),
    )
    const skills = listSkills().map(skillToManifest)
    // MCP 投影（只读展示，启停走 McpSettings 页）；enabled 来自 server 配置
    const mcpServers = await loadMcpConfig()
    const mcp = mcpServers.map((s) => ({
      id: `mcp/${s.id}`,
      kind: 'mcp' as const,
      name: s.name,
      version: '0.1.0',
      description: '',
      enabled: s.enabled !== false,
      source: 'mcp' as const,
      effects: { tools: [] as string[], storage: [] as string[] },
    }))
    // builtin 聚合（只读展示，静态打包不可卸载）；排除 generated/generated_b/external 等动态 kind
    const builtinTools = listBuiltinToolDefs().filter(
      (t) =>
        !t.name.startsWith('generated/') &&
        !t.name.startsWith('generated_b/') &&
        !t.name.startsWith('external/'),
    )
    const builtinManifest: OnePluginManifest = {
      id: 'builtin',
      kind: 'builtin',
      name: '',
      version: '0.1.0',
      description: '',
      enabled: true,
      source: 'builtin',
      effects: { tools: builtinTools.map((t) => t.name), storage: [] },
    }
    return [...generated, ...generatedB, ...external, ...skills, ...mcp, builtinManifest]
  })

  // —— 单个插件详情（generated / generated_b 可展开看 manifest）——
  withHandler<OnePluginManifest | null>('plugins:get', (_e, input) => {
    const { id } = input as { id: string }
    // generated/<id> → 剥前缀转 bare 再查存储层，返回时重新加前缀保持回传一致
    if (id.startsWith('generated_b/')) {
      const bare = id.slice('generated_b/'.length)
      const m = loadGeneratedBPluginManifest(bare)
      return m ? { ...m, id: `generated_b/${m.id}` } : null
    }
    if (id.startsWith('generated/')) {
      const bare = id.slice('generated/'.length)
      const m = loadGeneratedPluginManifest(bare)
      return m ? { ...m, id: `generated/${m.id}` } : null
    }
    if (id.startsWith('external/')) {
      const bare = id.slice('external/'.length)
      const m = loadExternalPluginManifest(bare)
      return m ? { ...m, id: `external/${m.id}` } : null
    }
    // skill/<id>
    if (id.startsWith('skill/')) {
      const skillId = id.slice('skill/'.length)
      const skill = listSkills().find((s) => s.id === skillId)
      return skill ? skillToManifest(skill) : null
    }
    return null
  })

  // —— 启用插件（generated/generated_b: onLoad 注册；skill: 改 frontmatter enabled）——
  withHandler<void>('plugins:enable', async (_e, input) => {
    const { id } = input as { id: string }
    if (id.startsWith('generated_b/')) {
      await enableGeneratedBPlugin(pluginHost, id.slice('generated_b/'.length))
    } else if (id.startsWith('generated/')) {
      await enableGeneratedPlugin(pluginHost, id.slice('generated/'.length))
    } else if (id.startsWith('external/')) {
      await enableExternalPlugin(pluginHost, id.slice('external/'.length))
    } else if (id.startsWith('skill/')) {
      const skillId = id.slice('skill/'.length)
      await skillHostManager.enableSkill(skillId)
    } else {
      throw new Error(`unknown plugin id: ${id}`)
    }
  })

  // —— 禁用插件（generated/generated_b: onUnload 回滚；skill: 改 frontmatter enabled）——
  withHandler<void>('plugins:disable', async (_e, input) => {
    const { id } = input as { id: string }
    if (id.startsWith('generated_b/')) {
      await disableGeneratedBPlugin(id.slice('generated_b/'.length))
    } else if (id.startsWith('generated/')) {
      await disableGeneratedPlugin(id.slice('generated/'.length))
    } else if (id.startsWith('external/')) {
      await disableExternalPlugin(id.slice('external/'.length))
    } else if (id.startsWith('skill/')) {
      const skillId = id.slice('skill/'.length)
      await skillHostManager.disableSkill(skillId)
    } else {
      throw new Error(`unknown plugin id: ${id}`)
    }
  })

  // —— 卸载插件（generated/generated_b: onUnload + 删目录；skill: 暂只禁用）——
  withHandler<void>('plugins:uninstall', async (_e, input) => {
    const { id } = input as { id: string }
    if (id.startsWith('generated_b/')) {
      await uninstallGeneratedBPlugin(id.slice('generated_b/'.length))
    } else if (id.startsWith('generated/')) {
      await uninstallGeneratedPlugin(id.slice('generated/'.length))
    } else if (id.startsWith('external/')) {
      await uninstallExternalPlugin(id.slice('external/'.length))
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

  // —— 信任 generated/B 代码型插件（写盘 trustedBy + 重载切真 handler）——
  // B 专属：占位（untrusted）↔ 真 handler（trusted，always 审批）切换。A 无信任态，调此 handler 对 A 报错。
  withHandler<void>('plugins:trust', async (_e, input) => {
    const { id, trust } = input as { id: string; trust: boolean }
    const isCodePlugin = id.startsWith('generated_b/') || id.startsWith('external/')
    if (!isCodePlugin) {
      throw new Error(`trust only applies to generated_b/external plugins: ${id}`)
    }
    const prefix = id.startsWith('generated_b/') ? 'generated_b/' : 'external/'
    const bare = id.slice(prefix.length)
    if (trust) {
      // userId 单用户固定 'local'（无登录无鉴权，仅作信任事实记录者）
      if (prefix === 'generated_b/') {
        await trustGeneratedBPlugin(pluginHost, bare, 'local')
      } else {
        await trustExternalPlugin(pluginHost, bare, 'local')
      }
    } else {
      // 取消信任：写 trustedBy=null + 重载回占位（untrusted 占位）
      if (prefix === 'generated_b/') {
        const { setTrustedBPlugin } = await import('../plugins/generatedB')
        setTrustedBPlugin(bare, null)
        await disableGeneratedBPlugin(bare)
        await enableGeneratedBPlugin(pluginHost, bare)
      } else {
        setTrustedExternalPlugin(bare, null)
        await disableExternalPlugin(bare)
        await enableExternalPlugin(pluginHost, bare)
      }
    }
  })
}
