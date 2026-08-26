import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Notification } from 'electron'
import type { AgentConfig, LlmMessage } from '@shared/types'
import { Agent } from '../orchestrator/agent'
import { getDefaultProvider, getPersona, resolveProviderCredentials } from '../storage/models'
import { buildL2Injection } from '../storage/memory/l2'
import { withOrchestrationMemory } from '../storage/memory/compose'
import { listToolsForAgents } from '../tools/mcp'
import { resolveThinkingConfig } from '../llm/thinking'
import { endRun, startRun, appendRunEvent } from '../storage/runEvents'
import { logger } from '../logger'

// —— 定时任务执行适配器（§定时任务）——
// 两类触发目标：orchestration（跑一次 One 编排）/ shell（执行固定命令，execFile 不开 shell）。
// 均 headless（无渲染层）：编排结果落 run_events（entry='scheduled'），shell 仅记录成败。
// fail-closed：编排内需要审批的工具（approvalMode='always'，如 shell_run）自动拒绝、
// ask_user 返回空，避免 headless 无限挂起。

const DEFAULT_USER_ID = 'local'

/** 桌面通知（主进程可直接 new Notification） */
export function notify(title: string, body: string): void {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body }).show()
    }
  } catch (e) {
    logger.warn('[scheduler] 通知失败', e)
  }
}

export interface OrchestrationRunResult {
  output: string
  error?: string
}

/**
 * 运行一次编排（给定 prompt）。复用默认 provider 凭据 + 全局工具 + 记忆基座，
 * 单 Agent 直接执行（不进编排图，语义上是「定时跑这条 prompt」）。
 */
export async function runOrchestrationAction(
  prompt: string,
  opts: { modelId?: string; name?: string } = {},
): Promise<OrchestrationRunResult> {
  const runId = `run_${randomUUID()}`
  startRun({ id: runId, sessionId: undefined, entry: 'scheduled' })
  const finish = (status: 'completed' | 'error', output: string, error?: string): OrchestrationRunResult => {
    endRun(runId, status)
    return { output, error }
  }
  try {
    const provider = getDefaultProvider()
    if (!provider) {
      appendRunEvent(runId, 'scheduled.no_provider', {}, undefined)
      return finish('error', '', 'no_provider')
    }
    const { apiKey, baseURL, authHeader, modelId, enableThinking, apiFormat } =
      resolveProviderCredentials(provider, 'default')
    if (!modelId) {
      appendRunEvent(runId, 'scheduled.no_model', {}, undefined)
      return finish('error', '', 'no_default_model')
    }
    const effectiveModel = opts.modelId ?? modelId

    // 记忆基座：L0 用户身份 + L2 跨会话摘要（对齐 home/orchestrate，铁律 21）
    const persona = getPersona()
    const baseInstructions = persona?.instructions ?? ''
    const l2 = buildL2Injection(DEFAULT_USER_ID)
    const instructions = withOrchestrationMemory(baseInstructions, persona, l2)

    const agentTools = await listToolsForAgents()
    const config: AgentConfig = {
      name: 'scheduled',
      instructions,
      modelId: effectiveModel,
      tools: agentTools,
      defaultOptions: { maxTokens: 16384 },
      thinking: resolveThinkingConfig(effectiveModel, apiFormat, enableThinking ?? false),
    }
    const agent = new Agent(config, {
      llmOpts: { apiKey, baseURL, authHeader, apiFormat },
      // runId 让工具事件落 run_events；onApprove 自动拒绝、onAskUser 返回无人值守提示（fail-closed）
      toolCtx: {
        runId,
        signal: undefined,
        onApprove: async () => ({ approved: false, reason: 'scheduled_headless' }),
        onAskUser: async () => '[scheduled run: 无人值守，无法应答]',
      },
    })
    const messages: LlmMessage[] = [{ role: 'user', content: prompt }]
    const result = await agent.run({ messages, runId, signal: undefined }, {})
    appendRunEvent(runId, 'scheduled.completed', { outputLen: result.finalText.length }, undefined)
    return finish('completed', result.finalText)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    appendRunEvent(runId, 'scheduled.error', { error: msg }, undefined)
    return finish('error', '', msg)
  }
}

export interface ShellRunResult {
  stdout: string
  stderr: string
  /** 退出码（数字）或 spawn 失败的 errno 字符串（如 'EACCES'）；无错误为 0 */
  code: number | string | null
  error?: string
  timedOut?: boolean
}

/**
 * 执行固定命令（execFile，不开 shell，杜绝 shell 注入；参数走数组不拼字符串）。
 * 带超时；cwd 缺省进程 cwd。fail-closed：仅执行用户显式配置的命令，不 eval 任意字符串。
 */
export function runShellAction(
  command: string,
  args: string[] = [],
  cwd?: string,
  timeoutMs = 60_000,
): Promise<ShellRunResult> {
  return new Promise<ShellRunResult>((resolve) => {
    if (!command || !command.trim()) {
      resolve({ stdout: '', stderr: '', code: null, error: 'empty_command' })
      return
    }
    // execFile 回调已涵盖所有 spawn/exit 错误（含 ENOENT/EACCES/超时 kill），
    // 不再挂 child.on('error')：该事件与回调可能双触发，且其路径丢失 timedOut 语义。
    execFile(command, args, { cwd, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: 0 })
        return
      }
      const e = err as NodeJS.ErrnoException & { killed?: boolean }
      // spawn 失败（文件不存在 / 无权限）：code 是 errno 字符串
      const code = typeof e.code === 'string' ? e.code : e.code ?? 1
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        code,
        error: e.message,
        timedOut: e.killed === true,
      })
    })
  })
}
