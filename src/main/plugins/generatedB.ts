// —— generated/B 代码型插件（docs/PLUGIN_ARCHITECTURE.md §3"生成形态 B 层" + §5 Stage 3）——
//
// 由 AI/用户运行时提出一段可执行 handler 源码，持久化为
// config/generated-plugins/<id>/{manifest.json, handler.js}。onLoad 读盘 →
// validateGeneratedBSpec 校验 → 按信任状态注册占位或真 handler。
//
// 信任闸门三态（manifest.trustedBy 决定）：
// - null（未信任）：注册占位工具（approvalMode='auto'），handler 返 trusted_required，
//   LLM 调到后看到提示引导用户去 /plugins 页信任。
// - 非空（已信任）：注册真 code handler（approvalMode='always'，每次弹审批），
//   handler = vm 沙箱编译产物 + runBHandler 超时/截断包装，ctx 只暴露 executeTool 白名单。
// - 校验/编译失败：不注册任何工具，emit plugin.registered{status:'failed'} + logger.error。
//
// A/B 共用 generated-plugins/ 目录根，靠 id 前缀互斥（A=gen_、B=genb_，正则过滤无串扰）。

import { existsSync, readdirSync, rmSync } from 'node:fs'
import { relative } from 'node:path'
import { z } from 'zod'
import {
  getGeneratedBHandlerPath,
  getGeneratedPluginDir,
  getGeneratedPluginManifestPath,
  getGeneratedPluginsDir,
} from '../storage/paths'
import { readJsonFile, removeFile, writeJsonFile, writeTextFile } from '../storage/json-store'
import { newToolUseId, type ToolContext } from '../tools/registry'
import { pluginEvents } from './events'
import { validateGeneratedBSpec, validatePluginConfigSchema } from './whitelist'
import { resolvePluginConfig } from './config'
import { compileBHandler, runBHandler } from './sandbox'
import type { GeneratedBSpec } from './contracts'
import type { OnePluginManifest, PluginHost, PluginLifecycle } from './contracts'
import { IpcErrorThrow, type PluginConfigField } from '@shared/types'
import { logger } from '../logger'

/** 工具名命名空间前缀（所有权边界 + unregisterByPrefix 清理；区别于 A 的 generated/） */
export const GENERATED_B_TOOL_PREFIX = 'generated_b/'

/**
 * B id 合法性：随机 slug 形如 genb_<base36+random>，纯字母数字。
 * 与 A 的 gen_ 前缀互斥（A 的 isValidGeneratedId = /^gen_/，B 的 genb_ 被 A 正则拒绝）。
 * 用于防御路径穿越——存储层按 id 拼路径（join + rmSync），非法 id 不得进入读/删路径。
 */
const GENERATED_B_ID_RE = /^genb_[A-Za-z0-9]+$/
export function isValidGeneratedBId(id: string): boolean {
  return GENERATED_B_ID_RE.test(id)
}

/** 子路径是否仍位于父目录内（OS 无关，防 .. 逃逸） */
function isInsideDir(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || !rel.startsWith('..')
}

/** B 插件 manifest：OnePluginManifest + specB */
export interface GeneratedBPluginManifest extends OnePluginManifest {
  kind: 'generated_b'
  source: 'builtin' | 'registry' | 'external'
  specB: GeneratedBSpec
  trustedBy: { userId: string; ts: number } | null
}

/** manifest 持久化结构（外层包装：id + spec + enabled + trustedBy + configSchema + 元信息） */
interface GeneratedBPluginFile {
  id: string
  spec: GeneratedBSpec
  enabled: boolean
  trustedBy: { userId: string; ts: number } | null
  /** 插件配置项声明（secret 字段经 vaultKeyId 引用，明文不落盘） */
  configSchema?: PluginConfigField[]
  createdAt: number
  updatedAt: number
}

/**
 * 从持久化文件 → OnePluginManifest（统一插件视图，供 /plugins 页展示）。
 * specB.name 是用户起的工具名（如 extract_pkg），manifest.id 是 generated_b/<slug>。
 */
function fileToManifest(file: GeneratedBPluginFile): GeneratedBPluginManifest {
  const toolName = `${GENERATED_B_TOOL_PREFIX}${file.spec.name}`
  return {
    id: file.id,
    kind: 'generated_b',
    name: file.spec.name,
    version: '0.1.0',
    description: file.spec.description,
    enabled: file.enabled,
    source: 'builtin',
    specB: file.spec,
    trustedBy: file.trustedBy,
    configSchema: file.configSchema,
    effects: {
      tools: [toolName],
      storage: [],
    },
  }
}

/** 单个 B 插件（长生命周期，manifest 驱动 + 信任闸门） */
export class GeneratedBPlugin implements PluginLifecycle {
  private handle: { unregister: () => void } | null = null
  constructor(private readonly manifest: GeneratedBPluginManifest) {}

  get id(): string {
    return this.manifest.id
  }

  async onLoad(host: PluginHost): Promise<void> {
    const spec = this.manifest.specB
    // —— 注册点校验（fail-closed）——handlerSource 非空 + 可编译 + inputSchema 结构
    const result = validateGeneratedBSpec(spec)
    const toolName = `${GENERATED_B_TOOL_PREFIX}${spec.name}`
    if (!result.ok) {
      pluginEvents.emit('plugin.registered', {
        id: this.manifest.id,
        toolPrefix: toolName,
        status: 'failed',
        reason: result.reason,
      })
      logger.error(
        `[generated-B] 拒绝注册 ${toolName}：${result.reason}（${result.messageKey}）`,
      )
      return
    }

    // —— configSchema 注册点校验（fail-closed，与 spec 同源闸门）——
    const cfgResult = validatePluginConfigSchema(this.manifest.configSchema)
    if (!cfgResult.ok) {
      pluginEvents.emit('plugin.registered', {
        id: this.manifest.id,
        toolPrefix: toolName,
        status: 'failed',
        reason: cfgResult.reason,
      })
      logger.error(
        `[generated-B] 拒绝注册 ${toolName}（configSchema）：${cfgResult.reason}（${cfgResult.messageKey}）`,
      )
      return
    }

    const trusted = this.manifest.trustedBy !== null
    const looseZod = z.record(z.string(), z.unknown())

    if (!trusted) {
      // —— 未信任：注册占位工具（approvalMode='auto'，不弹审批）——
      // 占位就是要被 LLM 调到、返回 trusted_required 提示让 LLM 引导用户去信任。
      // 若占位也 always，用户审批了占位才看到「未信任」会很困惑。
      this.handle = host.tools.register({
        name: toolName,
        // TODO(i18n)：「未信任」标记硬编码在 LLM 可见 description（跟随主助手中文人设），英文 persona 场景待统一
        description: `${spec.description} [未信任]`,
        params: looseZod,
        approvalMode: 'auto',
        options: { inputSchemaOverride: spec.inputSchema },
        handler: async () => ({
          content: JSON.stringify({
            error: 'trusted_required',
            messageKey: 'errors:plugins.trusted_required',
          }),
          isError: true,
        }),
      })
    } else {
      // —— 已信任：解析 configSchema → ctx.config（secret 走 vault，明文不落渲染层/沙箱）——
      // configSchema 结构校验已在上方注册点闸门完成（两分支都过），此处仅做运行时解析。
      const config = await resolvePluginConfig(host, this.manifest.configSchema)
      const factory = compileBHandler(spec.handlerSource, this.manifest.id)
      this.handle = host.tools.register({
        name: toolName,
        description: spec.description,
        params: looseZod,
        approvalMode: 'always',
        options: { inputSchemaOverride: spec.inputSchema },
        handler: async (args, ctx: ToolContext) => {
          const res = await runBHandler(factory, args, ctx, config)
          return {
            content: res.content,
            isError: res.isError,
            toolUseId: ctx.toolUseId ?? newToolUseId(),
          }
        },
      })
    }

    pluginEvents.emit('plugin.registered', {
      id: this.manifest.id,
      toolPrefix: toolName,
      status: 'ok',
    })
    logger.info(
      `[generated-B] 已注册 ${toolName}（${trusted ? 'trusted' : 'untrusted 占位'}）`,
    )
  }

  async onUnload(reason: 'disable' | 'uninstall' | 'shutdown'): Promise<void> {
    this.handle?.unregister()
    this.handle = null
    pluginEvents.emit('plugin.unloaded', { id: this.manifest.id, reason })
    logger.info(`[generated-B] 已卸载 ${this.manifest.id}（${reason}）`)
  }
}

// —— 持久化（config/generated-plugins/<id>/{manifest.json, handler.js}，原子写盘 §11.4）——

/**
 * 工具名冲突检查：同命名空间内 spec.name 不得被其他 id 占用。
 * 工具名是 registry 所有权边界（onUnload 按名 unregister）——两插件同名会导致
 * 后注册覆盖先注册（registerTool 冲突仅 warn），且卸载其一会把另一个的注册误卸。
 */
function assertToolNameAvailable(name: string, selfId?: string): void {
  for (const m of listGeneratedBPluginManifests()) {
    if (m.id !== selfId && m.specB.name === name) {
      throw new IpcErrorThrow(
        'errors:plugins.tool_name_conflict',
        `generated_b tool name conflict: ${name} (owned by ${m.id})`,
      )
    }
  }
}

/** 保存 B 插件（新建或覆盖）；manifest.json 存 spec（含 handlerSource）+ trustedBy + configSchema，handler.js 存纯源码 */
export function saveGeneratedBPlugin(input: {
  id?: string
  spec: GeneratedBSpec
  enabled?: boolean
  trustedBy?: { userId: string; ts: number } | null
  /** 插件配置项声明；传入则持久化，覆盖既有 configSchema */
  configSchema?: PluginConfigField[]
}): GeneratedBPluginFile {
  const now = Date.now()
  if (input.id !== undefined && !isValidGeneratedBId(input.id)) {
    throw new Error(`invalid generated_b plugin id: ${input.id}`)
  }
  assertToolNameAvailable(input.spec.name, input.id)
  const existing = input.id ? loadGeneratedBPluginFile(input.id) : null
  const id = input.id ?? `genb_${now.toString(36)}${Math.random().toString(36).slice(2, 10)}`
  const file: GeneratedBPluginFile = {
    id,
    spec: input.spec,
    enabled: input.enabled ?? existing?.enabled ?? true,
    trustedBy: input.trustedBy ?? existing?.trustedBy ?? null,
    configSchema: input.configSchema ?? existing?.configSchema,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  // manifest.json 存完整 file（含 handlerSource 字符串）
  writeJsonFile(getGeneratedPluginManifestPath(id), file)
  // handler.js 存纯源码（供查看/编辑，不经 JSON 转义）；原子写盘，与 manifest.json 同约定（§11.4）
  writeTextFile(getGeneratedBHandlerPath(id), file.spec.handlerSource)
  return file
}

/** 读单个 manifest 文件（原始持久化结构）；非法 id 或 file.id 与请求不符直接跳过（防 .. 逃逸 + 篡改） */
function loadGeneratedBPluginFile(id: string): GeneratedBPluginFile | null {
  if (!isValidGeneratedBId(id)) return null
  const path = getGeneratedPluginManifestPath(id)
  if (!existsSync(path)) return null
  const file = readJsonFile<GeneratedBPluginFile | null>(path, null)
  if (!file || file.id !== id) return null
  return file
}

/** 读单个 manifest（OnePluginManifest 视图，供 /plugins 页） */
export function loadGeneratedBPluginManifest(id: string): GeneratedBPluginManifest | null {
  const file = loadGeneratedBPluginFile(id)
  return file ? fileToManifest(file) : null
}

/** 列出全部 B 插件 manifest（OnePluginManifest 视图，按更新时间倒序） */
export function listGeneratedBPluginManifests(): GeneratedBPluginManifest[] {
  const dir = getGeneratedPluginsDir()
  if (!existsSync(dir)) return []
  const files: GeneratedBPluginFile[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = loadGeneratedBPluginFile(entry.name)
    if (file) files.push(file)
  }
  return files.sort((a, b) => b.updatedAt - a.updatedAt).map(fileToManifest)
}

/** 翻转 enabled（持久化，不直接 onUnload——由 IPC 层调 onUnload/onLoad） */
export function setGeneratedBPluginEnabled(
  id: string,
  enabled: boolean,
): GeneratedBPluginFile | null {
  const file = loadGeneratedBPluginFile(id)
  if (!file) return null
  file.enabled = enabled
  file.updatedAt = Date.now()
  writeJsonFile(getGeneratedPluginManifestPath(id), file)
  return file
}

/** 翻转信任（持久化 + 重载切占位↔真 handler） */
export function setTrustedBPlugin(
  id: string,
  trustedBy: { userId: string; ts: number } | null,
): GeneratedBPluginFile | null {
  const file = loadGeneratedBPluginFile(id)
  if (!file) return null
  file.trustedBy = trustedBy
  file.updatedAt = Date.now()
  writeJsonFile(getGeneratedPluginManifestPath(id), file)
  return file
}

/** 删除 B 插件目录（卸载时调用）；非法 id 或路径逃逸 base 一律拒绝（fail-closed 删路径） */
export function removeGeneratedBPlugin(id: string): void {
  if (!isValidGeneratedBId(id)) {
    throw new Error(`invalid generated_b plugin id: ${id}`)
  }
  const dir = getGeneratedPluginDir(id)
  const base = getGeneratedPluginsDir()
  if (!isInsideDir(base, dir)) {
    throw new Error(`generated_b plugin dir escapes base: ${dir}`)
  }
  rmSync(dir, { recursive: true, force: true })
  // 兜底删一次 manifest 路径（dir 内文件已被 rm，防极少数 fs 行为差异）
  removeFile(getGeneratedPluginManifestPath(id))
  removeFile(getGeneratedBHandlerPath(id))
}

// —— 启动时加载全部 enabled 的 B 插件（仿 initGeneratedPlugins，Promise.allSettled 非阻塞）——

/** 进程内缓存：已 onLoad 的 GeneratedBPlugin 实例（id → instance），供 enable/disable/uninstall 复用 */
const loadedBPlugins = new Map<string, GeneratedBPlugin>()

/** 启动时加载全部 B 插件：enabled 的 onLoad 注册，disabled 的只留 manifest。单个失败不阻塞其他。 */
export async function initGeneratedBPlugins(host: PluginHost): Promise<void> {
  const manifests = listGeneratedBPluginManifests()
  if (manifests.length === 0) return
  await Promise.allSettled(
    manifests.map(async (manifest) => {
      const plugin = new GeneratedBPlugin(manifest)
      loadedBPlugins.set(manifest.id, plugin)
      if (manifest.enabled) {
        try {
          await plugin.onLoad(host)
        } catch (e) {
          logger.error(`[generated-B] 启动加载 ${manifest.id} 失败`, e)
        }
      }
    }),
  )
  logger.info(`[generated-B] 启动加载完成：${manifests.length} 个插件`)
}

/** 启用一个 B 插件（onLoad 注册）——供 IPC plugins:enable */
export async function enableGeneratedBPlugin(host: PluginHost, id: string): Promise<void> {
  const manifest = loadGeneratedBPluginManifest(id)
  if (!manifest) throw new Error(`generated_b plugin not found: ${id}`)
  setGeneratedBPluginEnabled(id, true)
  let plugin = loadedBPlugins.get(id)
  if (!plugin) {
    plugin = new GeneratedBPlugin(manifest)
    loadedBPlugins.set(id, plugin)
  }
  await plugin.onLoad(host)
}

/** 禁用一个 B 插件（onUnload 回滚）——供 IPC plugins:disable */
export async function disableGeneratedBPlugin(id: string): Promise<void> {
  setGeneratedBPluginEnabled(id, false)
  const plugin = loadedBPlugins.get(id)
  if (plugin) {
    await plugin.onUnload('disable')
  }
}

/** 卸载一个 B 插件（onUnload + 删目录）——供 IPC plugins:uninstall */
export async function uninstallGeneratedBPlugin(id: string): Promise<void> {
  const plugin = loadedBPlugins.get(id)
  if (plugin) {
    await plugin.onUnload('uninstall')
    loadedBPlugins.delete(id)
  }
  removeGeneratedBPlugin(id)
}

/**
 * 设置信任态并按需重载（plugins:trust 唯一入口，信任/取消信任同路径）。
 * disabled 插件只落盘 trustedBy、不动 registry——启用时才按新信任态注册，
 * 防"信任一个已禁用插件 → 工具绕过 enabled 闸门悄悄上线"。
 */
export async function setBPluginTrusted(
  host: PluginHost,
  id: string,
  trustedBy: { userId: string; ts: number } | null,
): Promise<void> {
  const file = setTrustedBPlugin(id, trustedBy)
  if (!file) throw new Error(`generated_b plugin not found: ${id}`)
  if (!file.enabled) return
  const existing = loadedBPlugins.get(id)
  if (existing) await existing.onUnload('disable')
  const manifest = loadGeneratedBPluginManifest(id)
  if (!manifest) throw new Error(`generated_b plugin manifest missing: ${id}`)
  const plugin = new GeneratedBPlugin(manifest)
  loadedBPlugins.set(id, plugin)
  await plugin.onLoad(host)
}

/** 列出全部 B 插件 manifest（供 IPC plugins:list） */
export function listGeneratedBPluginsForApi(): GeneratedBPluginManifest[] {
  return listGeneratedBPluginManifests()
}

/** 进程退出时卸载全部 B 插件（onUnload('shutdown')，对称 disconnectAll） */
export async function disconnectAllB(): Promise<void> {
  for (const plugin of loadedBPlugins.values()) {
    try {
      await plugin.onUnload('shutdown')
    } catch (e) {
      logger.error(`[generated-B] shutdown 卸载 ${plugin.id} 失败`, e)
    }
  }
  loadedBPlugins.clear()
}
