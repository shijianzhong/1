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
import { getAgent, getDefaultModel, resolveModelCredentials } from '../storage/models'
import { listToolDefs } from '../tools/registry'
import type { AgentExecutorOptions } from '../orchestrator/patterns/agent'
import { logger } from '../logger'

// —— 编排 IPC（§5.6 + §八之二 B + §三之三 F）——
// orchestrate:run(graph, input, sessionId) → buildWorkflow → runWorkflow
// → webContents.send('orchestrate:stream', event) 流式推渲染层。

const STREAM_CHANNEL = 'orchestrate:stream'

function getMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

function emitStream(event: StreamEvent): void {
  const win = getMainWindow()
  win?.webContents.send(STREAM_CHANNEL, event)
}

/** 从节点 id 解析 AgentExecutorOptions（含 config/llmOpts/tools） */
function makeResolveAgent(modelId: string, apiKey?: string, baseURL?: string): (nodeId: string) => AgentExecutorOptions | null {
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
      llmOpts: { apiKey, baseURL },
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

      const model = getDefaultModel()
      if (!model) throw new Error('未配置模型')
      const { apiKey, baseURL } = resolveModelCredentials(model)
      const deps: BuildDeps = {
        resolveAgent: makeResolveAgent(model.modelId, apiKey, baseURL),
      }

      const wf = buildWorkflow(graph, deps)

      const result = await runWorkflow(wf, { text, sessionId }, emitStream)
      return { runId: sessionId ?? `run_${randomUUID().slice(0, 8)}`, output: result.output }
    },
  )
}
