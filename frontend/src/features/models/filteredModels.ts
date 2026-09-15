import type { ModelSettingsConfig, Speed } from '@/types/models'
import type { ModelCatalogEntry, ModelReasoningOption } from './types'
import { CANONICAL_REASONING_ORDER, isHiddenReasoningLevel } from './types'

const CANONICAL_REASONING_RANK = new Map<string, number>(
    CANONICAL_REASONING_ORDER.map((id, index) => [id, index]),
)

export function getReasoningOptions(
    model: ModelCatalogEntry | undefined,
): readonly ModelReasoningOption[] {
    if (!model) return []
    const source = model.reasoningLevels ?? []
    const seen = new Set<string>()
    const unique = source.filter((option) => {
        if (!option?.id || isHiddenReasoningLevel(option.id) || seen.has(option.id)) return false
        seen.add(option.id)
        return true
    })

    return unique
        .map((option, index) => ({ option, index }))
        .sort((left, right) => {
            const leftRank = CANONICAL_REASONING_RANK.get(left.option.id) ?? CANONICAL_REASONING_ORDER.length
            const rightRank = CANONICAL_REASONING_RANK.get(right.option.id) ?? CANONICAL_REASONING_ORDER.length
            return leftRank - rightRank || left.index - right.index
        })
        .map(({ option }) => option)
}

export function getDefaultReasoningLevel(
    model: ModelCatalogEntry | undefined,
): string {
    const options = getReasoningOptions(model)
    if (options.length === 0) return 'off'
    const midIndex = Math.floor(options.length / 2)
    return options[midIndex]?.id ?? 'off'
}

export function normalizeModelPreferences(
    model: ModelCatalogEntry | undefined,
    reasoningLevel: string,
    speed: Speed,
): { reasoningLevel: string; speed: Speed } {
    if (!model) {
        return { reasoningLevel: reasoningLevel || 'off', speed: 'standard' }
    }
    const reasoningOptions = getReasoningOptions(model)
    const defaultReasoning = getDefaultReasoningLevel(model)
    const nextReasoningLevel = reasoningOptions.length === 0
        ? 'off'
        : reasoningOptions.some((option) => option.id === reasoningLevel)
            ? reasoningLevel
            : defaultReasoning
    const nextSpeed =
        !model.supportsFast || speed === 'standard' ? 'standard' : 'fast'

    return {
        reasoningLevel: nextReasoningLevel,
        speed: nextSpeed,
    }
}

/**
 * Reorder models based on user-configured modelOrder array.
 * Models appearing in modelOrder are sorted according to their index in that array.
 * Models not present in modelOrder maintain their relative original order at the end.
 */
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

export function withoutHiddenReasoningLevels(
    levels: readonly ModelReasoningOption[],
): readonly ModelReasoningOption[] {
    return levels.filter((level) => !isHiddenReasoningLevel(level.id))
}

export function stripHiddenReasoningLevels(
    models: readonly ModelCatalogEntry[],
): readonly ModelCatalogEntry[] {
    return models.map(withoutHiddenReasoning)
}

function withoutHiddenReasoning(model: ModelCatalogEntry): ModelCatalogEntry {
    const reasoningLevels = withoutHiddenReasoningLevels(model.reasoningLevels ?? [])
    if (reasoningLevels.length === model.reasoningLevels.length) {
        return model
    }
    return {
        ...model,
        reasoningLevels,
    }
}

/**
 * Filter catalog models and their reasoning levels according to user settings.
 * When `enableAll` is true (default), all catalog models and reasoning levels are returned in configured order.
 * The `ultra` reasoning level is always hidden.
 * When `enableAll` is false, only models with enabled !== false are returned in configured order,
 * with their reasoning levels filtered to the enabled set.
 */
export function getFilteredModels(
    catalogModels: readonly ModelCatalogEntry[],
    modelSettings?: ModelSettingsConfig,
): readonly ModelCatalogEntry[] {
    const ordered = orderModels(catalogModels, modelSettings?.modelOrder).map(
        withoutHiddenReasoning,
    )

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
