import type { Provider } from '@shared/types'
import { withHandler } from './handler'
import {
  getProvider,
  listProviders,
  removeProvider,
  saveProvider,
} from '../storage/models'

// —— Provider IPC（同一服务商多个模型共享 key + baseUrl）——
export function registerProvidersHandlers(): void {
  withHandler<Provider[]>('providers:list', () => listProviders())
  withHandler<Provider | null>('providers:get', (_e, id) => getProvider(id as string))
  withHandler<Provider>('providers:save', (_e, input) => saveProvider(input))
  withHandler<void>('providers:remove', (_e, id) => removeProvider(id as string))
}
