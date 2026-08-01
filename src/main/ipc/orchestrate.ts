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
import {
  newRequestId,
  rejectAllUserInputs,
  resolveUserInput,
  waitForUserInput,
} from '../orchestrator/userInput'
import { getSkill, getAgent, getDefaultProvider, resolveProviderCredentials } from '../storage/models'
import { addMessage } from '../storage/sessions'
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
 *  signal：取消运行贯穿到 agent tool-use 循环与 ask_user 挂起等待。
 */
function makeResolveAgent(
  modelId: string,
  apiKey?: string,
  baseURL?: string,
  authHeader?: string,
  enableThinking?: boolean,
  apiFormat?: ApiFormat,
  signal?: AbortSignal,
): (node: GraphNode) => AgentExecutorOptions | null {
  // 运行期 skill 缓存：同一次运行内多个节点绑定同一 skill 时只读一次磁盘
  // （每次 run 新建 resolver → 缓存随运行结束丢弃，不会吃到过期内容）
  const skillCache = new Map<string, ReturnType<typeof getSkill>>()
  const getSkillCached = (sid: string): ReturnType<typeof getSkill> => {
    const cached = skillCache.get(sid)
    if (cached !== undefined) return cached
    const skill = getSkill(sid)
    skillCache.set(sid, skill)
    return skill
  }

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

    // 铁律20：executor_id == 节点 id（runner 按节点 id 路由/查找）。
    // 不能用 data.label（角色显示名）——否则 executors.get(node.id) 找不到 → 空白气泡
    const agentName = node.id

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
      const skill = getSkillCached(sid)
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

    // outputConstraints 注入 instructions（运行时才吃得到）
    const finalInstructions = agentOutputConstraints
      ? `${instructions}\n\n【输出约束】\n${agentOutputConstraints}`
      : instructions

    const config: AgentConfig = {
      name: agentName,
      description: agentDescription,
      instructions: finalInstructions,
      modelId: agentModelId,
      tools: listToolDefs(),
      defaultOptions: { maxTokens: agentMaxTokens, temperature: agentTemperature },
      outputConstraints: agentOutputConstraints,
      thinking,
    }
    return {
      config,
      llmOpts: { apiKey, baseURL, authHeader },
      toolCtx: {
        signal,
        // HITL 提问桥：ask_user → request_info 事件推前端 + 挂起等作答（userInput 队列）
        onAskUser: async ({ question, context }) => {
          const requestId = newRequestId()
          emitStream({ type: 'request_info', request_id: requestId, node_id: node.id, question, context })
          try {
            const answer = await waitForUserInput(requestId, { nodeId: node.id, question }, signal)
            emitStream({ type: 'request_resolved', request_id: requestId, node_id: node.id, response: answer })
            return answer
          } catch (e) {
            // 超时/取消：通知前端卡片定格（空 response = 失效），错误抛回工具侧转错误 JSON
            emitStream({ type: 'request_resolved', request_id: requestId, node_id: node.id, response: '' })
            throw e
          }
        },
      },
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

      // 先建 AbortController：signal 贯穿 toolCtx（agent 循环 + ask_user 挂起），
      // cancel 才能真正打断「等用户作答」与工具循环（原来只断 superstep 间隙）。
      // 并发防御：已有运行时先取消旧的（渲染层 running 守卫下不会并发，兜底重复 IPC）
      if (currentAbortController) {
        logger.warn('[orchestrate] 已有运行中的编排，自动取消旧运行')
        currentAbortController.abort()
      }
      currentAbortController = new AbortController()
      const { signal } = currentAbortController
      const deps: BuildDeps = {
        resolveAgent: makeResolveAgent(modelId, apiKey, baseURL, authHeader, enableThinking, apiFormat, signal),
      }

      const wf = buildWorkflow(graph, deps)

      // 会话持久化（编辑器运行落 session，与首页 @能力 运行对齐）：用户输入 + 聚合输出
      if (sessionId) addMessage({ sessionId, role: 'user', content: text })
      try {
        const result = await runWorkflow(wf, { text, sessionId }, emitStream, signal)
        if (sessionId && result.output) {
          addMessage({ sessionId, role: 'assistant', content: result.output })
        }
        return { runId: sessionId ?? `run_${randomUUID().slice(0, 8)}`, output: result.output }
      } finally {
        // 运行结束（含异常）：驳回该运行残留的挂起提问，防泄漏到下一场运行。
        // 只清自己的控制器（期间新运行接管则不动新句柄）
        rejectAllUserInputs('run_finished')
        if (currentAbortController?.signal === signal) currentAbortController = null
      }
    },
  )

  // 用户作答 ask_user 提问（渲染层提问卡提交）。requestId 全局唯一，
  // home 通道的组队运行也走同一 userInput 队列，故 respond 收口在本通道。
  withHandler<void>('orchestrate:respond', async (_e, input) => {
    const { requestId, response } = input as { requestId: string; response: string }
    if (!requestId || typeof response !== 'string') throw new Error('参数缺失')
    const found = resolveUserInput(requestId, response)
    if (!found) throw new Error('提问已失效（超时或已作答）')
  })

  withHandler<void>(
    'orchestrate:cancel',
    async () => {
      rejectAllUserInputs('aborted') // 先驳回挂起提问，让工具侧收尾
      if (currentAbortController) {
        currentAbortController.abort()
        currentAbortController = null
        logger.info('[orchestrate] 已取消编排')
      }
    },
  )
}
