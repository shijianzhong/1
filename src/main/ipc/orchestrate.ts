import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import type {
  AgentConfig,
  GraphNode,
  LlmToolDef,
  StreamEvent,
  WorkflowGraph,
} from '@shared/types'
import { withHandler } from './handler'
import { buildWorkflow, type BuildDeps } from '../orchestrator/builder'
import { runWorkflow } from '../orchestrator/runner'
import { getAgent, getDefaultProvider, resolveProviderCredentials } from '../storage/models'
import { listToolDefs } from '../tools/registry'
import type { AgentExecutorOptions } from '../orchestrator/patterns/agent'
import { logger } from '../logger'

// —— 编排 IPC（§5.6 + §八之二 B + §三之三 F）——
// orchestrate:run(graph, input, sessionId) → buildWorkflow → runWorkflow
// → webContents.send('orchestrate:stream', event) 流式推渲染。
// cc switch 范式：凭据 + modelId 从默认 provider 取。

const STREAM_CHANNEL = 'orchestrate:stream'

function getMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

function emitStream(event: StreamEvent): void {
  const win = getMainWindow()
  win?.webContents.send(STREAM_CHANNEL, event)
}

/** 从节点 id 解析 AgentExecutorOptions（含 config/llmOpts/tools） */
function makeResolveAgent(
  modelId: string,
  apiKey?: string,
  baseURL?: string,
  authHeader?: string,
): (nodeId: string) => AgentExecutorOptions | null {
  return (nodeId: string): AgentExecutorOptions | null => {
    const agent = getAgent(nodeId)
    if (!agent) return null
    const config: AgentConfig = {
      name: agent.name,
      description: agent.description,
      instructions: agent.instructions,
      modelId: agent.modelId ?? modelId,
      tools: listToolDefs(),
      defaultOptions: { maxTokens: agent.maxTokens ?? 16384, temperature: agent.temperature },
      outputConstraints: agent.outputConstraints,
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
      const { apiKey, baseURL, authHeader, modelId } = resolveProviderCredentials(provider, 'default')
      if (!modelId) throw new Error('供应商未配置默认模型')
      const deps: BuildDeps = {
        resolveAgent: makeResolveAgent(modelId, apiKey, baseURL, authHeader),
      }

      const wf = buildWorkflow(graph, deps)

      const result = await runWorkflow(wf, { text, sessionId }, emitStream)
      return { runId: sessionId ?? `run_${randomUUID().slice(0, 8)}`, output: result.output }
    },
  )
}
