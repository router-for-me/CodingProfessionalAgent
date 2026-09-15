import type { ModelCatalogEntry, ModelReasoningOption, Speed } from '@cpa/plugin-api'
import { CANONICAL_REASONING_ORDER } from '../types.js'

export interface SpeedOption {
    id: Speed
    labelKey: string
}

export const MODEL_MENU_WIDTH_PX = 234

const CANONICAL_REASONING_RANK = new Map<string, number>(
    CANONICAL_REASONING_ORDER.map((id, index) => [id, index]),
)

export function getReasoningOptions(
    model: ModelCatalogEntry | undefined,
): readonly ModelReasoningOption[] {
    if (!model) return []
    const rawSource = model.reasoningLevels ?? (model as any).supportedReasoningEfforts ?? []
    const source: ModelReasoningOption[] = rawSource.map((item: any) =>
        typeof item === 'string' ? { id: item, label: item } : item
    )
    const seen = new Set<string>()
    const unique = source.filter((option) => {
        if (
            !option ||
            !option.id ||
            option.id.trim().toLowerCase() === 'ultra' ||
            seen.has(option.id)
        ) {
            return false
        }
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

export function getDefaultReasoningOption(
    model: ModelCatalogEntry | undefined,
): ModelReasoningOption | undefined {
    const options = getReasoningOptions(model)
    if (options.length === 0) return undefined
    const midIndex = Math.floor(options.length / 2)
    return options[midIndex]
}

export function getDefaultReasoningLevel(
    model: ModelCatalogEntry | undefined,
): string {
    const defaultOption = getDefaultReasoningOption(model)
    return defaultOption ? defaultOption.id : 'off'
}

export function getSpeedOptions(supportsFast: boolean): readonly SpeedOption[] {
    if (!supportsFast) return [{ id: 'standard', labelKey: 'composer.speed.standard' }]

    return [
        { id: 'standard', labelKey: 'composer.speed.standard' },
        { id: 'fast', labelKey: 'composer.speed.fast' },
    ]
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

export function compareModelsByName(
    a: ModelCatalogEntry,
    b: ModelCatalogEntry,
): number {
    const nameA = a.label?.trim() || a.id
    const nameB = b.label?.trim() || b.id
    const comparison = nameA.localeCompare(nameB, undefined, {
        numeric: true,
        sensitivity: 'base',
    })
    if (comparison !== 0) {
        return comparison
    }
    const strictNameComparison = nameA.localeCompare(nameB, undefined, {
        numeric: true,
    })
    if (strictNameComparison !== 0) {
        return strictNameComparison
    }
    return a.id.localeCompare(b.id, undefined, { numeric: true })
}

export function sortModelsByName(
    models: readonly ModelCatalogEntry[],
): readonly ModelCatalogEntry[] {
    return [...models].sort(compareModelsByName)
}

export function filterCatalogModels(
    models: readonly ModelCatalogEntry[],
    modelSettings?: any,
): readonly ModelCatalogEntry[] {
    if (!modelSettings?.models) return models
    const configured = models.filter((m) => {
        const config = modelSettings.models[m.id]
        return config ? config.enabled !== false : true
    })
    return configured.length > 0 ? configured : models
}
