import type {
    ModelCatalogEntry,
    ModelReasoningOption,
    ModelSettingsConfig,
} from '@cpa/plugin-api'

export type { ModelCatalogEntry, ModelReasoningOption, ModelSettingsConfig }

export const CANONICAL_REASONING_ORDER = [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra',
] as const

const REASONING_LABEL_KEYS: Record<string, string> = {
    off: 'composer.reasoning.off',
    minimal: 'composer.reasoning.minimal',
    low: 'composer.reasoning.low',
    medium: 'composer.reasoning.medium',
    high: 'composer.reasoning.high',
    xhigh: 'composer.reasoning.xhigh',
    max: 'composer.reasoning.max',
    ultra: 'composer.reasoning.ultra',
}

export const CANONICAL_REASONING_OPTIONS: readonly ModelReasoningOption[] =
    CANONICAL_REASONING_ORDER.map((effort) => ({
        id: effort,
        requestValue: effort,
        labelKey: REASONING_LABEL_KEYS[effort],
    }))

export function orderModels(
    models: readonly ModelCatalogEntry[],
    modelOrder?: readonly string[],
): readonly ModelCatalogEntry[] {
    if (!modelOrder || modelOrder.length === 0) {
        return models
    }

    const rankMap = new Map<string, number>(
        modelOrder.map((id, index) => [id, index]),
    )

    return [...models]
        .map((model, index) => ({ model, index }))
        .sort((a, b) => {
            const rankA = rankMap.has(a.model.id)
                ? rankMap.get(a.model.id)!
                : modelOrder.length + a.index
            const rankB = rankMap.has(b.model.id)
                ? rankMap.get(b.model.id)!
                : modelOrder.length + b.index
            return rankA - rankB || a.index - b.index
        })
        .map(({ model }) => model)
}

export function getFilteredModels(
    catalogModels: readonly ModelCatalogEntry[],
    modelSettings?: ModelSettingsConfig,
): readonly ModelCatalogEntry[] {
    const ordered = orderModels(catalogModels, modelSettings?.modelOrder)

    if (!modelSettings || modelSettings.enableAll) {
        return ordered
    }

    return ordered.flatMap((model) => {
        const config = modelSettings.models?.[model.id]
        if (config && config.enabled === false) {
            return []
        }

        if (config && Array.isArray(config.enabledReasoningLevels)) {
            const enabledSet = new Set(config.enabledReasoningLevels)
            const filteredReasoning = model.reasoningLevels.filter((level) =>
                enabledSet.has(level.id)
            )
            return [{
                ...model,
                reasoningLevels: filteredReasoning,
            }]
        }

        return [model]
    })
}
