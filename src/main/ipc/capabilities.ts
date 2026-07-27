import type { Capability } from '@shared/types'
import { withHandler } from './handler'
import {
  getCapability,
  listCapabilities,
  removeCapability,
  saveCapability,
} from '../storage/models'

// —— 能力（编排图）IPC（§八之二 B）——
export function registerCapabilitiesHandlers(): void {
  withHandler<Capability[]>('capabilities:list', () => listCapabilities())
  withHandler<Capability | null>('capabilities:get', (_e, id) =>
    getCapability(id as string),
  )
  withHandler<Capability>('capabilities:save', (_e, input) =>
    saveCapability(input),
  )
  withHandler<void>('capabilities:remove', (_e, id) =>
    removeCapability(id as string),
  )
}
