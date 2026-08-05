import Ajv from 'ajv'
import { z } from 'zod'
import { registerTool, unregisterByPrefix, hasTool } from '../registry'
import { listServerTools, callServerTool } from './client'
import { logger } from '../../logger'
import type { McpServerConfig } from '@shared/types'

// —— MCP 工具 → tool registry 适配器 ——
// 将 MCP 服务器暴露的工具注册到 One 的工具注册表中，命名 mcp__{serverId}__{toolName}。
// 关键设计：
// 1. inputSchemaOverride：MCP 工具自带 JSON Schema，直接传给 LLM，绕过 zodToJsonSchema 限制
// 2. AJV 运行时校验：MCP 工具不用 Zod，用 AJV 校验入参
// 3. approvalMode 默认 always：MCP 工具行为未知，安全起见每次调用需用户确认

const TOOL_PREFIX = 'mcp__'

const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: true })
type AjvValidator = ReturnType<typeof ajv.compile> | null
const validatorCache = new Map<string, AjvValidator>()

/** 连接服务器后注册其所有工具到 registry */
export async function registerMcpTools(config: McpServerConfig): Promise<number> {
  const tools = await listServerTools(config.id)
  const prefix = `${TOOL_PREFIX}${config.id}__`
  let count = 0

  for (const tool of tools) {
    const fullName = `${prefix}${tool.name}`

    // 冲突检测（同 server 重连时 unregisterMcpTools 已清理，此处防跨 server 冲突）
    if (hasTool(fullName)) {
      logger.warn(`[mcp] tool name conflict, skipped: ${fullName}`)
      continue
    }

    // MCP 工具的 inputSchema（JSON Schema 格式，直接给 LLM）
    const inputSchema = (tool.inputSchema ?? {
      type: 'object',
      properties: {},
    }) as Record<string, unknown>

    // 编译 AJV 校验器（编译失败则跳过校验）
    let validate: AjvValidator
    try {
      validate = ajv.compile(inputSchema)
    } catch (e) {
      logger.warn(`[mcp] invalid JSON Schema for ${fullName}, skipping validation`, e)
      validate = null
    }
    validatorCache.set(fullName, validate)

    const description =
      tool.description ?? `MCP tool: ${tool.name} (from ${config.name})`

    // 捕获 tool.name 到局部变量（闭包安全）
    const mcpToolName = tool.name

    registerTool(
      fullName,
      description,
      z.record(z.string(), z.unknown()), // 宽松 Zod（通过 safeParse），真正校验由 AJV 在 handler 内做
      async (args, ctx) => {
        // AJV 入参校验
        const validator = validatorCache.get(fullName)
        if (validator && !validator(args)) {
          return {
            ok: false,
            error: 'invalid_args',
            detail: ajv.errorsText(validator.errors),
          }
        }

        // 调用 MCP 服务器
        try {
          const result = await callServerTool(
            config.id,
            mcpToolName,
            args as Record<string, unknown>,
            ctx.signal,
          )

          // 从 CallToolResult 提取文本内容
          const content = (result as {
            content?: Array<{ type: string; text?: string }>
          }).content
          const textParts: string[] = []
          if (content) {
            for (const item of content) {
              if (item.type === 'text' && item.text) {
                textParts.push(item.text)
              }
            }
          }

          const isError = (result as { isError?: boolean }).isError ?? false
          return {
            ok: !isError,
            content: textParts.join('\n') || JSON.stringify(result),
            isError,
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          return {
            ok: false,
            error: 'mcp_tool_call_failed',
            messageKey: 'errors.mcp.tool_call_failed',
            detail: msg,
          }
        }
      },
      config.approvalMode ?? 'always', // 默认每次调用需确认
      { inputSchemaOverride: inputSchema },
    )
    count++
  }

  logger.info(`[mcp] registered ${count} tool(s) for ${config.name}`)
  return count
}

/** 注销服务器的所有工具 */
export function unregisterMcpTools(serverId: string): number {
  const prefix = `${TOOL_PREFIX}${serverId}__`
  // 清理 AJV 校验器缓存
  for (const key of validatorCache.keys()) {
    if (key.startsWith(prefix)) validatorCache.delete(key)
  }
  const removed = unregisterByPrefix(prefix)
  if (removed > 0) {
    logger.info(`[mcp] unregistered ${removed} tool(s) for ${serverId}`)
  }
  return removed
}
