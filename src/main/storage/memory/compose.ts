import type { Persona } from '@shared/types'
import { injectL0 } from './l0'

// —— 编排路径记忆基座（对齐 home.ts §三之三 D）——
// workflow 内每个 agent 都应看到用户身份（L0）与跨会话长期摘要（L2），否则编排"失忆"。
// 此前记忆只在首页 ipc/home 注入，编排路径（capability / 组队图）完全未接。
// 纯函数：base 指令 + L2 跨会话摘要（接末尾）+ L0 用户身份块（接头），与 home 拼装顺序一致。
export function withOrchestrationMemory(
  baseInstructions: string,
  persona: Persona | null,
  l2Injection: string,
): string {
  const withL2 = l2Injection ? `${baseInstructions}\n\n${l2Injection}` : baseInstructions
  return injectL0(withL2, persona)
}
