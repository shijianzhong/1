import type { Agent } from '@shared/types'
import { withHandler } from './handler'
import { getAgent, listAgents, removeAgent, saveAgent } from '../storage/models'

// —— 角色 IPC（§八之二 B）——
export function registerAgentsHandlers(): void {
  withHandler<Agent[]>('agents:list', () => listAgents())
  withHandler<Agent | null>('agents:get', (_e, id) => getAgent(id as string))
  withHandler<Agent>('agents:save', (_e, input) => saveAgent(input))
  withHandler<void>('agents:remove', (_e, id) => removeAgent(id as string))
}
