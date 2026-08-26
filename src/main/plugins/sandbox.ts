// —— generated/B 代码型工具 vm 沙箱（docs/PLUGIN_ARCHITECTURE.md §3 B 层 + §5 Stage 3）——
//
// 这是项目首次引入沙箱执行（全仓此前无 node:vm 先例）。安全模型：
// 1. vm.runInNewContext 编译 B handler 源码，context 只注入 executeTool，
//    不暴露 require/process/global/__dirname——B handler 无法 require fs/shell。
// 2. executeTool 是唯一能力出口：调白名单 8 动作（file_read/file_search/kb_search/
//    web_search/glob/grep/skill_search/load_skill），白名单外动作返回错误，逃不出去。
// 3. runBHandler 用 Promise.race + AbortSignal 做 60s 超时（vm timeout 只管同步段，
//    async await 在 microtask 不受管，已验证）；输出截断 16KB（同 skillScript OUT_CAP）。
//    【已知限制：同步死循环 DoS】vm timeout 仅能中止同步段；若 B handler 写纯同步死循环
//    （如 `while(true){}`），Promise.race 的 abort 信号无法打断同步执行，会永久占住事件循环。
//    该路径仅在用户于 /plugins 页"信任"后才可达（consent-based），属主动授权后的自伤面；
//    未来根治方向：将 B handler 执行移入 worker thread（独立线程，可 terminate 强杀）。见 docs/PLUGIN_ARCHITECTURE.md B 层小节。
// 4. B 工具 approvalMode='always'（注册时定），每次调用弹审批——信任≠免审。
//
// 编译方式（已验证）：vm.runInNewContext 包成 `(function(executeTool){ return async function handler(args, ctx){ <src> } })`，
// 返回 async handler。编译步不设 vm timeout（Node 拒绝 timeout:0），同步段极短，真正超时由 runBHandler 管。

import vm from 'node:vm'
import { executeTool, newToolUseId, type ToolContext, type ToolResult } from '../tools/registry'
import { WHITELIST_ACTIONS, type WhitelistAction } from './whitelist'

/** B handler 编译产物：签名为 async (args, ctx) => unknown */
export type BHandler = (args: unknown, ctx: { executeTool: BExecuteTool }) => Promise<unknown>
/** B handler 工厂：编译产物先绑 executeTool 才得到 BHandler（运行时绑定，编译期不绑） */
export type BHandlerFactory = (executeTool: BExecuteTool) => BHandler
/** 沙箱内 ctx.executeTool 签名：调白名单动作，返回 ToolResult */
export type BExecuteTool = (action: string, args: Record<string, unknown>) => Promise<ToolResult>

/** 运行时围栏数值（参照 skillScript.ts，同口径） */
const TIMEOUT_MS = 60_000
const OUT_CAP = 16_000

/**
 * 编译 B handler 源码。纯编译，不执行。
 * @returns BHandlerFactory；SyntaxError 时抛（由调用方 catch 转成 validateGeneratedBSpec 的 compile_failed）
 */
export function compileBHandler(source: string, id: string): BHandlerFactory {
  const wrapped = `(function(executeTool){ return async function handler(args, ctx){ ${source} } })`
  // filename 让编译错误栈带 B 插件 id；不设 timeout——编译步仅建函数对象、不执行 handler 体，
  // 无需同步段超时；运行期超时由 runBHandler 的 Promise.race 管（Node vm 拒绝 timeout:0，须省略）
  const factory = vm.runInNewContext(wrapped, {}, { filename: `generatedB/${id}.handler.js` })
  if (typeof factory !== 'function') {
    throw new Error('handler source did not compile to a function')
  }
  // factory 签名 (executeTool) => async handler；这里只编译不绑定 executeTool（运行时再传）
  return factory as BHandlerFactory
}

/**
 * 构造沙箱内 ctx.executeTool：白名单闸门 + 透传外层 B 的 ToolContext。
 * B handler 内调 executeTool(action, args) → 检查 action 在白名单 → 调 registry.executeTool
 * 复用全部闸门（zod/preCheck/approval/重试/run_events）。白名单外→返回 action_not_whitelisted 错误。
 */
function makeCtxExecuteTool(bCtx: ToolContext, signal?: AbortSignal): BExecuteTool {
  return async (action: string, args: Record<string, unknown>): Promise<ToolResult> => {
    if (!WHITELIST_ACTIONS.includes(action as WhitelistAction)) {
      return {
        toolUseId: bCtx.toolUseId ?? newToolUseId(),
        content: JSON.stringify({
          error: 'action_not_whitelisted',
          messageKey: 'errors:plugins.action_not_whitelisted',
          action,
        }),
        isError: true,
      }
    }
    // 白名单动作自身的 approvalMode（全 auto），不继承 B 的 always
    return executeTool(action, args, newToolUseId(), { ...bCtx, signal })
  }
}

/**
 * 执行已编译的 B handler，带超时 + 输出截断围栏。
 * @param factory compileBHandler 的产物（(executeTool) => async handler）
 * @param args 工具入参
 * @param bCtx 外层 B 工具调用收到的 ToolContext
 * @returns ToolResult（content 截断到 16KB；超时/错误返回 isError:true 结构化 JSON）
 */
export async function runBHandler(
  factory: BHandlerFactory,
  args: unknown,
  bCtx: ToolContext,
): Promise<ToolResult> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  // unref 避免定时器阻止进程退出（与 skillScript 同纪律）
  timer.unref?.()

  const toolUseId = bCtx.toolUseId ?? newToolUseId()
  const execute = makeCtxExecuteTool(bCtx, ac.signal)

  try {
    const handler = factory(execute)
    const result = await Promise.race([
      handler(args, { executeTool: execute }),
      new Promise<never>((_, reject) => {
        ac.signal.addEventListener(
          'abort',
          () => reject(new Error('timeout')),
          { once: true },
        )
      }),
    ])
    clearTimeout(timer)
    // 序列化守卫：undefined/null 走 JSON.stringify（undefined 的 stringify 结果为 JS undefined 值，需特判）；
    // 字符串原样透传，其余 JSON 序列化（同 skillScript OUT_CAP 口径）
    const content =
      result === undefined
        ? ''
        : typeof result === 'string'
          ? result
          : JSON.stringify(result)
    if (content.length > OUT_CAP) {
      return {
        toolUseId,
        content: content.slice(0, OUT_CAP) + '\n[output truncated]',
        isError: false,
      }
    }
    return { toolUseId, content, isError: false }
  } catch (e) {
    clearTimeout(timer)
    const msg = e instanceof Error ? e.message : String(e)
    if (msg === 'timeout') {
      return {
        toolUseId,
        content: JSON.stringify({
          error: 'timeout',
          messageKey: 'errors:plugins.timeout',
        }),
        isError: true,
      }
    }
    return {
      toolUseId,
      content: JSON.stringify({ error: msg }),
      isError: true,
    }
  }
}
