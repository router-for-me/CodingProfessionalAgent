import type { ModelCatalogEntry, ModelReasoningOption, ModelSettingsConfig, Speed } from '@cpa/plugin-api'
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

export function filterReasoningOptionsBySettings(
    model: ModelCatalogEntry | undefined,
    modelSettings?: ModelSettingsConfig,
): readonly ModelReasoningOption[] {
    const base = getReasoningOptions(model)
    if (!model || !modelSettings || modelSettings.enableAll !== false) {
        return base
    }
    const enabledLevels = modelSettings.models?.[model.id]?.enabledReasoningLevels
    // Empty array falls back to all options to avoid deadlocks per spec; non-empty arrays act as strict allowlists
    if (!Array.isArray(enabledLevels) || enabledLevels.length === 0) {
        return base
    }
    const allowed = new Set(enabledLevels)
    return base.filter((opt) => allowed.has(opt.id))
}

export function normalizeModelPreferences(
    model: ModelCatalogEntry | undefined,
    reasoningLevel: string,
    speed: Speed,
    modelSettings?: ModelSettingsConfig,
): { reasoningLevel: string; speed: Speed } {
    if (!model) {
        return { reasoningLevel: reasoningLevel || 'off', speed: 'standard' }
    }
    const reasoningOptions = filterReasoningOptionsBySettings(model, modelSettings)
    const defaultOption =
        reasoningOptions.length > 0
            ? reasoningOptions[Math.floor(reasoningOptions.length / 2)]
            : undefined
    const defaultReasoning = defaultOption ? defaultOption.id : 'off'
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
    const isAllEnabled = modelSettings.enableAll !== false
    if (isAllEnabled) return models

    return models.flatMap((m) => {
        const config = modelSettings.models[m.id]
        if (config && config.enabled === false) {
            return []
        }

        const effectiveContextWindow =
            config &&
            typeof config.contextWindow === 'number' &&
            Number.isFinite(config.contextWindow) &&
            config.contextWindow > 0
                ? Math.floor(config.contextWindow)
                : m.contextWindow

        let effectiveReasoningLevels = m.reasoningLevels
        if (
            config &&
            Array.isArray(config.enabledReasoningLevels) &&
            config.enabledReasoningLevels.length > 0 &&
            Array.isArray(m.reasoningLevels)
        ) {
            const enabledSet = new Set(config.enabledReasoningLevels)
            effectiveReasoningLevels = m.reasoningLevels.filter((level) =>
                enabledSet.has(level.id),
            )
        }

        if (
            effectiveContextWindow !== m.contextWindow ||
            effectiveReasoningLevels !== m.reasoningLevels
        ) {
            return [
                {
                    ...m,
                    contextWindow: effectiveContextWindow,
                    reasoningLevels: effectiveReasoningLevels,
                },
            ]
        }
        return [m]
    })
}

export interface CommitModelSelectionParams {
    model: ModelCatalogEntry
    requestedReasoningLevel: string
    currentSpeed: Speed
    modelSettings?: ModelSettingsConfig
    sessionId?: string | null
    services?: {
        settings?: {
            setModelId?: (id: string) => void
            setReasoningLevel?: (level: string) => void
        }
        sessions?: {
            setSessionRuntimeSettings?: (
                sessionId: string,
                opts: { modelId?: string; reasoningEffort?: string; speed?: Speed },
            ) => void
        }
        ui?: {
            getPendingSessionContext?: () => any
            setPendingSessionContext?: (ctx: any) => void
        }
    } | null
    onPendingSpeedChange?: (speed: Speed) => void
}

export function commitModelSelection({
    model,
    requestedReasoningLevel,
    currentSpeed,
    modelSettings,
    sessionId,
    services,
    onPendingSpeedChange,
}: CommitModelSelectionParams): { reasoningLevel: string; speed: Speed } {
    const normalized = normalizeModelPreferences(
        model,
        requestedReasoningLevel,
        currentSpeed,
        modelSettings,
    )
    services?.settings?.setModelId?.(model.id)
    services?.settings?.setReasoningLevel?.(normalized.reasoningLevel)
    if (sessionId) {
        services?.sessions?.setSessionRuntimeSettings?.(sessionId, {
            modelId: model.id,
            reasoningEffort: normalized.reasoningLevel,
            speed: normalized.speed,
        })
    } else {
        const pendingContext = services?.ui?.getPendingSessionContext?.()
        if (pendingContext?.speed !== undefined || normalized.speed !== currentSpeed) {
            onPendingSpeedChange?.(normalized.speed)
            services?.ui?.setPendingSessionContext?.({
                ...pendingContext,
                speed: normalized.speed,
            })
        }
    }
    return normalized
}
