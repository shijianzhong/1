import type { ModelConfig } from '@shared/types'
import { withHandler } from './handler'
import { getModel, listModels, removeModel, saveModel } from '../storage/models'

// —— 模型配置 IPC（§八之二 B）——
export function registerModelsHandlers(): void {
  withHandler<ModelConfig[]>('models:list', () => listModels())
  withHandler<ModelConfig | null>('models:get', (_e, id) => getModel(id as string))
  withHandler<ModelConfig>('models:save', (_e, input) => saveModel(input))
  withHandler<void>('models:remove', (_e, id) => removeModel(id as string))
}
