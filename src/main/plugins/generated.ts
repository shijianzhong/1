// —— generated/A 声明式插件（docs/PLUGIN_ARCHITECTURE.md §3"生成形态 A 层" + §5 Stage 2）——
//
// 由 AI/用户运行时提出的只读/检索白名单工具，持久化为
// config/generated-plugins/<id>/manifest.json。onLoad 读盘 → 白名单校验 →
// host.tools.register；onUnload 调 unregisterByPrefix(generated/<id>) 回滚。
//
// 判发方式：A 工具 handler 内部调 executeTool(白名单动作名, {...spec.executeAction.params, ...args}, ...)
// 复用 executeTool 全部闸门（zod 校验/preCheck/approvalMode/重试/run_events）+
// file_read 的 resolveConfined 围栏自动继承。generated/A 自身 approvalMode='auto'。
// generated 的 inputSchema 仅用于 LLM 可见（registerTool 的 input_schema），
// 运行时 zod 校验由 executeTool 调白名单动作的 handler 做（宽松 zod 透传）。

import { existsSync, readdirSync, rmSync } from 'node:fs'
import { relative } from 'node:path'
import { z } from 'zod'
import {
  getGeneratedPluginDir,
  getGeneratedPluginManifestPath,
  getGeneratedPluginsDir,
} from '../storage/paths'
import { readJsonFile, removeFile, writeJsonFile } from '../storage/json-store'
import { executeTool, newToolUseId, type ToolContext } from '../tools/registry'
import { pluginEvents } from './events'
import { validateGeneratedSpec } from './whitelist'
import type { GeneratedPluginSpec } from './contracts'
import type { OnePluginManifest, PluginHost, PluginLifecycle } from './contracts'
import { logger } from '../logger'

/** 工具名命名空间前缀（所有权边界 + unregisterByPrefix 清理） */
export const GENERATED_TOOL_PREFIX = 'generated/'

/**
 * generated id 合法性：随机 slug 形如 gen_<base36+random>，纯字母数字。
 * 用于防御路径穿越——存储层按 id 拼路径（join + rmSync），非法 id 不得进入读/删路径。
 */
const GENERATED_ID_RE = /^gen_[A-Za-z0-9]+$/
export function isValidGeneratedId(id: string): boolean {
  return GENERATED_ID_RE.test(id)
}

/** 子路径是否仍位于父目录内（OS 无关，防 .. 逃逸） */
function isInsideDir(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !relative(parent, child).startsWith('..'))
}

/** generated 插件 manifest：OnePluginManifest + spec */
export interface GeneratedPluginManifest extends OnePluginManifest {
  kind: 'generated'
  source: 'builtin' | 'registry' | 'external'
  spec: GeneratedPluginSpec
}

/** manifest 持久化结构（外层包装：id + spec + enabled + 元信息） */
interface GeneratedPluginFile {
  id: string
  spec: GeneratedPluginSpec
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/**
 * 从持久化文件 → OnePluginManifest（统一插件视图，供 /plugins 页展示）。
 * spec.name 是用户起的工具名（如 my_reader），manifest.id 是 generated/<slug>。
 */
function fileToManifest(file: GeneratedPluginFile): GeneratedPluginManifest {
  const toolName = `${GENERATED_TOOL_PREFIX}${file.spec.name}`
  return {
    id: file.id,
    kind: 'generated',
    name: file.spec.name,
    version: '0.1.0',
    description: file.spec.description,
    enabled: file.enabled,
    source: 'builtin',
    spec: file.spec,
    effects: {
      tools: [toolName],
      storage: [],
    },
  }
}

/** 单个 generated 插件（长生命周期，manifest 驱动） */
export class GeneratedPlugin implements PluginLifecycle {
  private handle: { unregister: () => void } | null = null
  constructor(private readonly manifest: GeneratedPluginManifest) {}

  get id(): string {
    return this.manifest.id
  }

  async onLoad(host: PluginHost): Promise<void> {
    const spec = this.manifest.spec
    // —— 注册点白名单强校验（fail-closed）——非白名单动作 / 越界参数直接拒注册
    const result = validateGeneratedSpec(spec)
    const toolName = `${GENERATED_TOOL_PREFIX}${spec.name}`
    if (!result.ok) {
      pluginEvents.emit('plugin.registered', {
        id: this.manifest.id,
        toolPrefix: toolName,
        status: 'failed',
        reason: result.reason,
      })
      logger.error(
        `[generated] 拒绝注册 ${toolName}：${result.reason}（${result.messageKey}）`,
      )
      return
    }

    const action = spec.executeAction.action
    const fixedParams = spec.executeAction.params ?? {}
    const mcpLikeLooseZod = z.record(z.string(), z.unknown())

    this.handle = host.tools.register({
      name: toolName,
      description: spec.description,
      params: mcpLikeLooseZod,
      approvalMode: 'auto', // A 层：白名单只读/检索动作，auto（动作自身继承围栏/审批）
      options: { inputSchemaOverride: spec.inputSchema },
      handler: async (args, ctx: ToolContext) => {
        // 透传 args 给 executeTool（与 fixedParams 合并）——复用全部闸门 +
        // resolveConfined 围栏（file_read 等自动继承）。toolUseId 透传或新生成。
        const merged = { ...fixedParams, ...(args as Record<string, unknown>) }
        const toolUseId = ctx.toolUseId ?? newToolUseId()
        const res = await executeTool(action, merged, toolUseId, ctx)
        // executeTool 返回 ToolResult { content: string, isError: boolean }——
        // 已是 LLM 友好的 JSON 字符串，原样回传（content 即 Anthropic tool_result 文本）
        return res
      },
    })

    pluginEvents.emit('plugin.registered', {
      id: this.manifest.id,
      toolPrefix: toolName,
      status: 'ok',
    })
    logger.info(`[generated] 已注册 ${toolName}（action=${action}）`)
  }

  async onUnload(reason: 'disable' | 'uninstall' | 'shutdown'): Promise<void> {
    this.handle?.unregister()
    this.handle = null
    pluginEvents.emit('plugin.unloaded', { id: this.manifest.id, reason })
    logger.info(`[generated] 已卸载 ${this.manifest.id}（${reason}）`)
  }
}

// —— 持久化（config/generated-plugins/<id>/manifest.json，原子写盘 §11.4）——

/** 保存 generated 插件 manifest（新建或覆盖） */
export function saveGeneratedPlugin(input: {
  id?: string
  spec: GeneratedPluginSpec
  enabled?: boolean
}): GeneratedPluginFile {
  const now = Date.now()
  // 外部传入 id 必须合法（随机 slug）；不合法直接拒绝写盘（防路径逃逸）
  if (input.id !== undefined && !isValidGeneratedId(input.id)) {
    throw new Error(`invalid generated plugin id: ${input.id}`)
  }
  const existing = input.id ? loadGeneratedPluginFile(input.id) : null
  const id = input.id ?? `gen_${now.toString(36)}${Math.random().toString(36).slice(2, 10)}`
  const file: GeneratedPluginFile = {
    id,
    spec: input.spec,
    enabled: input.enabled ?? existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  writeJsonFile(getGeneratedPluginManifestPath(id), file)
  return file
}

/** 读单个 manifest 文件（原始持久化结构）；非法 id 或 file.id 与请求不符直接跳过（防 .. 逃逸 + 篡改） */
function loadGeneratedPluginFile(id: string): GeneratedPluginFile | null {
  if (!isValidGeneratedId(id)) return null
  const path = getGeneratedPluginManifestPath(id)
  if (!existsSync(path)) return null
  const file = readJsonFile<GeneratedPluginFile | null>(path, null)
  if (!file || file.id !== id) return null
  return file
}

/** 读单个 manifest（OnePluginManifest 视图，供 /plugins 页） */
export function loadGeneratedPluginManifest(id: string): GeneratedPluginManifest | null {
  const file = loadGeneratedPluginFile(id)
  return file ? fileToManifest(file) : null
}

/** 列出全部 generated 插件 manifest（OnePluginManifest 视图，按更新时间倒序） */
export function listGeneratedPluginManifests(): GeneratedPluginManifest[] {
  const dir = getGeneratedPluginsDir()
  if (!existsSync(dir)) return []
  const files: GeneratedPluginFile[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = loadGeneratedPluginFile(entry.name)
    if (file) files.push(file)
  }
  return files.sort((a, b) => b.updatedAt - a.updatedAt).map(fileToManifest)
}

/** 翻转 enabled（持久化，不直接 onUnload——由 IPC 层调 onUnload/onLoad） */
export function setGeneratedPluginEnabled(id: string, enabled: boolean): GeneratedPluginFile | null {
  const file = loadGeneratedPluginFile(id)
  if (!file) return null
  file.enabled = enabled
  file.updatedAt = Date.now()
  writeJsonFile(getGeneratedPluginManifestPath(id), file)
  return file
}

/** 删除 generated 插件目录（卸载时调用）；非法 id 或路径逃逸 base 一律拒绝（fail-closed 删路径） */
export function removeGeneratedPlugin(id: string): void {
  if (!isValidGeneratedId(id)) {
    throw new Error(`invalid generated plugin id: ${id}`)
  }
  const dir = getGeneratedPluginDir(id)
  const base = getGeneratedPluginsDir()
  if (!isInsideDir(base, dir)) {
    throw new Error(`generated plugin dir escapes base: ${dir}`)
  }
  rmSync(dir, { recursive: true, force: true })
  // manifest 文件可能在 dir 内已被 rm，兜底删一次 manifest 路径
  removeFile(getGeneratedPluginManifestPath(id))
}

// —— 启动时加载全部 enabled 的 generated 插件（仿 initMcpServers，Promise.allSettled 非阻塞）——

/** 进程内缓存：已 onLoad 的 GeneratedPlugin 实例（id → instance），供 enable/disable/uninstall 复用 */
const loadedPlugins = new Map<string, GeneratedPlugin>()

/** 已加载（含禁用的）manifest 视图，供 IPC list 用（不进 registry 但要展示） */
function allManifestsForList(): GeneratedPluginManifest[] {
  return listGeneratedPluginManifests()
}

/**
 * 启动时加载全部 generated 插件：enabled 的 onLoad 注册，disabled 的只留 manifest。
 * 单个失败不阻塞其他（allSettled）。
 */
export async function initGeneratedPlugins(host: PluginHost): Promise<void> {
  const manifests = allManifestsForList()
  if (manifests.length === 0) return
  await Promise.allSettled(
    manifests.map(async (manifest) => {
      // 即使 disabled 也缓存实例（但 disabled 不 onLoad 注册）
      const plugin = new GeneratedPlugin(manifest)
      loadedPlugins.set(manifest.id, plugin)
      if (manifest.enabled) {
        try {
          await plugin.onLoad(host)
        } catch (e) {
          logger.error(`[generated] 启动加载 ${manifest.id} 失败`, e)
        }
      }
    }),
  )
  logger.info(`[generated] 启动加载完成：${manifests.length} 个插件`)
}

/** 启用一个 generated 插件（onLoad 注册）——供 IPC plugins:enable */
export async function enableGeneratedPlugin(host: PluginHost, id: string): Promise<void> {
  const manifest = loadGeneratedPluginManifest(id)
  if (!manifest) throw new Error(`generated plugin not found: ${id}`)
  setGeneratedPluginEnabled(id, true)
  let plugin = loadedPlugins.get(id)
  if (!plugin) {
    plugin = new GeneratedPlugin(manifest)
    loadedPlugins.set(id, plugin)
  }
  await plugin.onLoad(host)
}

/** 禁用一个 generated 插件（onUnload 回滚）——供 IPC plugins:disable */
export async function disableGeneratedPlugin(id: string): Promise<void> {
  setGeneratedPluginEnabled(id, false)
  const plugin = loadedPlugins.get(id)
  if (plugin) {
    await plugin.onUnload('disable')
  }
}

/** 卸载一个 generated 插件（onUnload + 删目录）——供 IPC plugins:uninstall */
export async function uninstallGeneratedPlugin(id: string): Promise<void> {
  const plugin = loadedPlugins.get(id)
  if (plugin) {
    await plugin.onUnload('uninstall')
    loadedPlugins.delete(id)
  }
  removeGeneratedPlugin(id)
}

/** 列出全部 generated 插件 manifest（供 IPC plugins:list） */
export function listGeneratedPluginsForApi(): GeneratedPluginManifest[] {
  return allManifestsForList()
}

/** 进程退出时卸载全部 generated 插件（onUnload('shutdown')，对称 disconnectAllMcp） */
export async function disconnectAll(): Promise<void> {
  for (const plugin of loadedPlugins.values()) {
    try {
      await plugin.onUnload('shutdown')
    } catch (e) {
      logger.error(`[generated] shutdown 卸载 ${plugin.id} 失败`, e)
    }
  }
  loadedPlugins.clear()
}

