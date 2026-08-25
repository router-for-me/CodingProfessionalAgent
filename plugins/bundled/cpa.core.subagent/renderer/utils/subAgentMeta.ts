import type { ModelCatalogEntry, SubAgentRecord } from '@cpa/plugin-api'

type TFunction = (key: string, options?: any) => string

export function resolveChildReasoning(
  model: ModelCatalogEntry,
  preferred?: string,
): string | undefined {
  if (!model.reasoningLevels || model.reasoningLevels.length === 0) {
    return undefined
  }
  if (preferred) {
    const direct = model.reasoningLevels.find((level) => level.id === preferred)
    if (direct) return direct.id
  }
  const defaultLevel = model.reasoningLevels.find((level) => (level as any).isDefault)
  if (defaultLevel) return defaultLevel.id
  return model.reasoningLevels[0]?.id
}

export function resolveSubAgentModelLabel(
  modelId: string,
  models: readonly ModelCatalogEntry[],
): string {
  const match = models.find((entry) => entry.id === modelId)
  const label = match?.label.trim()
  return label && label.length > 0 ? label : modelId
}

export function resolveSubAgentReasoningLabel(
  effort: string | undefined,
  modelId: string,
  models: readonly ModelCatalogEntry[],
  t: TFunction,
): string | undefined {
  if (!effort) return undefined
  const model = models.find((entry) => entry.id === modelId)
  const option = model?.reasoningLevels.find(
    (level) => level.id === effort || level.requestValue === effort,
  )
  if (option?.labelKey) {
    const translated = t(option.labelKey)
    if (translated && translated !== option.labelKey) return translated
  }
  if (option?.fallbackLabel) return option.fallbackLabel
  const key = `composer.reasoning.${effort}`
  const translated = t(key)
  return translated && translated !== key ? translated : effort
}

export function subAgentDisplayMeta(
  agent: Pick<SubAgentRecord, 'modelId' | 'reasoningEffort'>,
  models: readonly ModelCatalogEntry[],
  preferredReasoning: string | undefined,
  t: TFunction,
): { modelLabel: string; reasoningLabel?: string } {
  const model = models.find((entry) => entry.id === agent.modelId)
  const effort =
    agent.reasoningEffort ??
    (model ? resolveChildReasoning(model, preferredReasoning) : undefined)
  return {
    modelLabel: resolveSubAgentModelLabel(agent.modelId, models),
    reasoningLabel: resolveSubAgentReasoningLabel(
      effort,
      agent.modelId,
      models,
      t,
    ),
  }
}
