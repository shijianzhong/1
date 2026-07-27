import type { Persona } from '@shared/types'
import { withHandler } from './handler'
import { getPersona, savePersona } from '../storage/models'

// —— 首页主助手人设 IPC（独立于角色，§八之二 B）——
export function registerPersonaHandlers(): void {
  withHandler<Persona | null>('persona:get', () => getPersona())
  withHandler<Persona>('persona:save', (_e, input) => savePersona(input))
}
