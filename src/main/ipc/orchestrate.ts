import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import type {
  AgentConfig,
  ApiFormat,
  GraphNode,
  LlmToolDef,
  StreamEvent,
  WorkflowGraph,
} from '@shared/types'
import { withHandler } from './handler'
import { buildWorkflow, type BuildDeps } from '../orchestrator/builder'
import { runWorkflow } from '../orchestrator/runner'
import { getSkill, getAgent, getDefaultProvider, resolveProviderCredentials } from '../storage/models'
import { listToolDefs } from '../tools/registry'
import { resolveThinkingConfig } from '../llm/thinking'
import type { AgentExecutorOptions } from '../orchestrator/patterns/agent'
import { logger } from '../logger'

// —— 编排 IPC（§5.6 + §八之二 B + §三之三 F）——
// orchestrate:run(graph, input, sessionId) → buildWorkflow → runWorkflow
// → webContents.send('orchestrate:stream', event) 流式推渲染。
// cc switch 范式：凭据 + modelId 从默认 provider 取。

const STREAM_CHANNEL = 'orchestrate:stream'

// 当前编排的 AbortController（用于 cancel）
let currentAbortController: AbortController | null = null

function getMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

function emitStream(event: StreamEvent): void {
  const win = getMainWindow()
  win?.webContents.send(STREAM_CHANNEL, event)
}

/** 从图节点解析 AgentExecutorOptions
 *  节点 data 内联了 Agent 配置快照（拖入时从全局 Agent 模板快照，之后节点级独立可改）。
 *  不再从全局 Agent 注册表查找，实现编排图自包含。
 */
function makeResolveAgent(
  modelId: string,
  apiKey?: string,
  baseURL?: string,
  authHeader?: string,
  enableThinking?: boolean,
  apiFormat?: ApiFormat,
): (node: GraphNode) => AgentExecutorOptions | null {
  return (node: GraphNode): AgentExecutorOptions | null => {
    const data = node.data as {
      instructions?: string
      description?: string
      skillIds?: string[]
      modelId?: string
      temperature?: number
      maxTokens?: number
      outputConstraints?: string
      label?: string
      sourceAgentId?: string
      agentId?: string
    }

    const agentName = data.label ?? node.id

    // —— 向后兼容：旧节点无快照配置时，从全局 Agent 回退读取 ——
    // 优先 sourceAgentId，回退 agentId（旧字段名）
    const refAgentId = data.sourceAgentId ?? data.agentId
    const hasSnapshot = data.instructions != null && data.instructions.length > 0
    const fallbackAgent = (!hasSnapshot && refAgentId) ? getAgent(refAgentId) : null

    const agentInstructions = data.instructions ?? fallbackAgent?.instructions ?? ''
    const agentDescription = data.description ?? fallbackAgent?.description
    const agentSkillIds = data.skillIds ?? fallbackAgent?.skillIds ?? []
    const agentTemperature = data.temperature ?? fallbackAgent?.temperature
    const agentMaxTokens = data.maxTokens ?? fallbackAgent?.maxTokens ?? 16384
    const agentOutputConstraints = data.outputConstraints ?? fallbackAgent?.outputConstraints
    const agentModelId = data.modelId ?? fallbackAgent?.modelId ?? modelId
    const thinking = resolveThinkingConfig(agentModelId, apiFormat, enableThinking ?? false)

    // —— Skill 注入（§铁律22）：读 skillIds → getSkill → inline 成 <skill> XML 块拼入 instructions ——
    const skillBlocks: string[] = []
    for (const sid of agentSkillIds) {
      const skill = getSkill(sid)
      if (!skill) {
        logger.warn(`[orchestrate] node ${agentName} 绑定的 skill ${sid} 不存在，跳过`)
        continue
      }
      // 限长 24000 字（§铁律22）
      const content = skill.content.length > 24000
        ? skill.content.slice(0, 24000) + '\n\n[... skill 内容超长截断 ...]'
        : skill.content
      const desc = skill.description ? `\n  description: ${skill.description}` : ''
      skillBlocks.push(`<skill name="${skill.name}"${desc}>\n${content}\n</skill>`)
    }
    const instructions = skillBlocks.length > 0
      ? `${agentInstructions}\n\n${skillBlocks.join('\n\n')}`
      : agentInstructions

    const config: AgentConfig = {
      name: agentName,
      description: agentDescription,
      instructions,
      modelId: agentModelId,
      tools: listToolDefs(),
      defaultOptions: { maxTokens: agentMaxTokens, temperature: agentTemperature },
      outputConstraints: agentOutputConstraints,
      thinking,
    }
    return {
      config,
      llmOpts: { apiKey, baseURL, authHeader },
      toolCtx: {},
    }
  }
}

export function registerOrchestrateHandlers(): void {
  withHandler<{ runId: string; output: string }>(
    'orchestrate:run',
    async (_e, input) => {
      const { graph, input: text, sessionId } = input as {
        graph: WorkflowGraph
        input: string
        sessionId?: string
      }

      const provider = getDefaultProvider()
      if (!provider) throw new Error('未配置供应商')
      const { apiKey, baseURL, authHeader, modelId, enableThinking, apiFormat } = resolveProviderCredentials(provider, 'default')
      if (!modelId) throw new Error('供应商未配置默认模型')
      const deps: BuildDeps = {
        resolveAgent: makeResolveAgent(modelId, apiKey, baseURL, authHeader, enableThinking, apiFormat),
      }

      const wf = buildWorkflow(graph, deps)

      // 创建 AbortController 并保存，供 cancel 使用
      currentAbortController = new AbortController()
      const result = await runWorkflow(
        wf,
        { text, sessionId },
        emitStream,
        currentAbortController.signal,
      )
      currentAbortController = null
      return { runId: sessionId ?? `run_${randomUUID().slice(0, 8)}`, output: result.output }
    },
  )

  withHandler<void>(
    'orchestrate:cancel',
    async () => {
      if (currentAbortController) {
        currentAbortController.abort()
        currentAbortController = null
        logger.info('[orchestrate] 已取消编排')
      }
    },
  )
}
