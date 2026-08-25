import React, { useMemo, useState, useEffect, useCallback } from 'react'
import { GripVertical, Search } from 'lucide-react'
import {
    cn,
    SettingsCard,
    SettingsRow,
    SettingsSection,
    ToggleSwitch,
    useHostServices,
    useTranslation,
} from '@cpa/plugin-ui'
import type { ModelCatalogEntry, ModelReasoningOption, ModelSettingsConfig } from '@cpa/plugin-api'

export const FALLBACK_MODEL_CATALOG: readonly ModelCatalogEntry[] = [
    {
        id: 'gpt-5.3-codex',
        label: 'GPT-5.3 Codex',
        description: 'Advanced flagship agent model with strong coding and reasoning.',
        supportsFast: true,
        reasoningLevels: [
            { id: 'low', requestValue: 'low', labelKey: 'composer.reasoning.low', fallbackLabel: 'Low' },
            { id: 'medium', requestValue: 'medium', labelKey: 'composer.reasoning.medium', fallbackLabel: 'Medium' },
            { id: 'high', requestValue: 'high', labelKey: 'composer.reasoning.high', fallbackLabel: 'High' },
        ],
        input: ['text', 'image'],
        contextWindow: 200_000,
        maxTokens: 32_768,
    },
    {
        id: 'gpt-5-mini',
        label: 'GPT-5 Mini',
        description: 'Fast, lightweight model optimized for quick coding tasks.',
        supportsFast: true,
        reasoningLevels: [
            { id: 'low', requestValue: 'low', labelKey: 'composer.reasoning.low', fallbackLabel: 'Low' },
            { id: 'medium', requestValue: 'medium', labelKey: 'composer.reasoning.medium', fallbackLabel: 'Medium' },
        ],
        input: ['text'],
        contextWindow: 128_000,
        maxTokens: 16_384,
    },
]

export const DEFAULT_MODEL_SETTINGS: ModelSettingsConfig = {
    enableAll: true,
    models: {},
    modelOrder: [],
}

export function orderModels(
    models: readonly ModelCatalogEntry[],
    modelOrder?: readonly string[],
): readonly ModelCatalogEntry[] {
    if (!modelOrder || modelOrder.length === 0) return models
    const modelMap = new Map(models.map((m) => [m.id, m]))
    const ordered: ModelCatalogEntry[] = []
    for (const id of modelOrder) {
        const m = modelMap.get(id)
        if (m) {
            ordered.push(m)
            modelMap.delete(id)
        }
    }
    for (const m of modelMap.values()) {
        ordered.push(m)
    }
    return ordered
}

function getReasoningLabel(
    translate: (key: string, options?: { defaultValue: string }) => string,
    option: ModelReasoningOption,
): string {
    if (!option.labelKey) return option.fallbackLabel ?? option.id
    return translate(option.labelKey, {
        defaultValue: option.fallbackLabel ?? option.id,
    })
}

export function ModelsSection() {
    const { t } = useTranslation()
    const services = useHostServices()

    const [settingsSnapshot, setSettingsSnapshot] = useState(() =>
        services?.settings?.getSnapshot?.() ?? ({} as any),
    )
    const [catalogModels, setCatalogModels] = useState<readonly ModelCatalogEntry[]>(() =>
        services?.models?.getModels?.() ?? [],
    )

    useEffect(() => {
        if (!services?.settings?.subscribe) return
        const unsubscribe = services.settings.subscribe(() => {
            setSettingsSnapshot(services.settings.getSnapshot?.() ?? ({} as any))
        })
        return unsubscribe
    }, [services?.settings])

    useEffect(() => {
        const modelService = services?.models
        if (!modelService?.subscribe) return
        const unsubscribe = modelService.subscribe(() => {
            setCatalogModels(modelService.getModels?.() ?? [])
        })
        return unsubscribe
    }, [services?.models])

    const modelSettings: ModelSettingsConfig =
        settingsSnapshot.modelSettings ?? DEFAULT_MODEL_SETTINGS

    const updateModelSettings = useCallback(
        (updater: (prev: ModelSettingsConfig) => ModelSettingsConfig) => {
            const current = settingsSnapshot.modelSettings ?? DEFAULT_MODEL_SETTINGS
            const next = updater(current)
            services?.settings?.update?.({ modelSettings: next })
        },
        [services?.settings, settingsSnapshot.modelSettings],
    )

    const rawModels = catalogModels.length > 0 ? catalogModels : FALLBACK_MODEL_CATALOG

    const orderedModels = useMemo(
        () => orderModels(rawModels, modelSettings.modelOrder),
        [rawModels, modelSettings.modelOrder],
    )

    const [searchQuery, setSearchQuery] = useState('')
    const [draggedId, setDraggedId] = useState<string | null>(null)
    const [dragOverId, setDragOverId] = useState<string | null>(null)

    const enableAll = modelSettings.enableAll !== false

    const filteredModels = useMemo(() => {
        const query = searchQuery.trim().toLowerCase()
        if (!query) return orderedModels
        return orderedModels.filter(
            (m) =>
                m.label.toLowerCase().includes(query) ||
                m.id.toLowerCase().includes(query) ||
                (m.description && m.description.toLowerCase().includes(query)),
        )
    }, [orderedModels, searchQuery])

    const handleDragStart = (id: string, e: React.DragEvent) => {
        e.dataTransfer.setData('text/plain', id)
        e.dataTransfer.effectAllowed = 'move'
        setDraggedId(id)
    }

    const handleDragOver = (id: string, e: React.DragEvent) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (dragOverId !== id) {
            setDragOverId(id)
        }
    }

    const handleDrop = (targetId: string, e: React.DragEvent) => {
        e.preventDefault()
        if (!draggedId || draggedId === targetId) {
            setDraggedId(null)
            setDragOverId(null)
            return
        }

        const currentOrder = orderedModels.map((m) => m.id)
        const fromIndex = currentOrder.indexOf(draggedId)
        const toIndex = currentOrder.indexOf(targetId)

        if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
            const nextOrder = [...currentOrder]
            const [moved] = nextOrder.splice(fromIndex, 1)
            nextOrder.splice(toIndex, 0, moved!)
            updateModelSettings((prev) => ({ ...prev, modelOrder: nextOrder }))
        }

        setDraggedId(null)
        setDragOverId(null)
    }

    const handleDragEnd = () => {
        setDraggedId(null)
        setDragOverId(null)
    }

    const setModelEnabled = useCallback(
        (modelId: string, enabled: boolean) => {
            updateModelSettings((prev) => ({
                ...prev,
                models: {
                    ...prev.models,
                    [modelId]: {
                        ...prev.models?.[modelId],
                        enabled,
                    },
                },
            }))
        },
        [updateModelSettings],
    )

    const setModelReasoningLevelEnabled = useCallback(
        (
            modelId: string,
            levelId: string,
            nextChecked: boolean,
            allReasoningIds: readonly string[],
        ) => {
            updateModelSettings((prev) => {
                const currentModelConfig = prev.models?.[modelId]
                const currentLevels =
                    currentModelConfig?.enabledReasoningLevels ?? [...allReasoningIds]
                let nextLevels: string[]
                if (nextChecked) {
                    nextLevels = currentLevels.includes(levelId)
                        ? currentLevels
                        : [...currentLevels, levelId]
                } else {
                    nextLevels = currentLevels.filter((id) => id !== levelId)
                }

                return {
                    ...prev,
                    models: {
                        ...prev.models,
                        [modelId]: {
                            ...currentModelConfig,
                            enabledReasoningLevels: nextLevels,
                        },
                    },
                }
            })
        },
        [updateModelSettings],
    )

    return (
        <div className="mx-auto w-full max-w-[760px] space-y-6 px-8 pt-8 pb-12">
            <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">
                {t('settings.models.title', { defaultValue: 'Models' })}
            </h1>

            <SettingsSection title={t('settings.models.section', { defaultValue: 'Model Configuration' })}>
                <SettingsCard>
                    <SettingsRow
                        title={t('settings.models.enableAll', { defaultValue: 'Enable all models and reasoning levels' })}
                        description={t('settings.models.enableAll.desc', {
                            defaultValue: 'Automatically enable all models from the catalog and all their supported reasoning efforts.',
                        })}
                        control={
                            <ToggleSwitch
                                checked={enableAll}
                                onChange={(checked) =>
                                    updateModelSettings((prev) => ({ ...prev, enableAll: checked }))
                                }
                                label={t('settings.models.enableAll', {
                                    defaultValue: 'Enable all models and reasoning levels',
                                })}
                            />
                        }
                        last
                    />
                </SettingsCard>
            </SettingsSection>

            {!enableAll ? (
                <SettingsSection title={t('settings.models.list.title', { defaultValue: 'Model List' })}>
                    {orderedModels.length > 3 ? (
                        <div className="mb-2">
                            <label className="relative block">
                                <Search
                                    className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--text-muted)]"
                                    aria-hidden
                                />
                                <input
                                    type="search"
                                    value={searchQuery}
                                    placeholder={t('settings.models.search.placeholder', {
                                        defaultValue: 'Search models...',
                                    })}
                                    aria-label={t('settings.models.search.placeholder', {
                                        defaultValue: 'Search models...',
                                    })}
                                    className={cn(
                                        'w-full rounded-lg border border-[var(--border-subtle)]',
                                        'bg-[var(--bg-card)] py-1.5 pl-8 pr-3 text-[12px]',
                                        'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
                                        'outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/30',
                                    )}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                />
                            </label>
                        </div>
                    ) : null}

                    <SettingsCard>
                        {filteredModels.length > 0 ? (
                            filteredModels.map((model, index) => {
                                const modelConfig = modelSettings.models?.[model.id]
                                const isModelEnabled = modelConfig ? modelConfig.enabled !== false : true
                                const allReasoningIds = model.reasoningLevels.map((l) => l.id)
                                const enabledLevels = modelConfig?.enabledReasoningLevels
                                const isLast = index === filteredModels.length - 1

                                return (
                                    <ModelSettingRow
                                        key={model.id}
                                        model={model}
                                        isModelEnabled={isModelEnabled}
                                        enabledLevels={enabledLevels}
                                        allReasoningIds={allReasoningIds}
                                        last={isLast}
                                        draggable={!searchQuery.trim()}
                                        isDragging={draggedId === model.id}
                                        isDragOver={dragOverId === model.id}
                                        onDragStart={handleDragStart}
                                        onDragOver={handleDragOver}
                                        onDrop={handleDrop}
                                        onDragEnd={handleDragEnd}
                                        onToggleModel={(val) => setModelEnabled(model.id, val)}
                                        onToggleReasoningLevel={(levelId, nextChecked) =>
                                            setModelReasoningLevelEnabled(
                                                model.id,
                                                levelId,
                                                nextChecked,
                                                allReasoningIds,
                                            )
                                        }
                                    />
                                )
                            })
                        ) : (
                            <div className="px-3.5 py-6 text-center text-[12px] text-[var(--text-muted)]">
                                {t('settings.models.empty', { defaultValue: 'No models found' })}
                            </div>
                        )}
                    </SettingsCard>
                </SettingsSection>
            ) : null}
        </div>
    )
}

interface ModelSettingRowProps {
    model: ModelCatalogEntry
    isModelEnabled: boolean
    enabledLevels: string[] | undefined
    allReasoningIds: readonly string[]
    last: boolean
    draggable?: boolean
    isDragging?: boolean
    isDragOver?: boolean
    onDragStart?: (id: string, e: React.DragEvent) => void
    onDragOver?: (id: string, e: React.DragEvent) => void
    onDrop?: (id: string, e: React.DragEvent) => void
    onDragEnd?: () => void
    onToggleModel: (enabled: boolean) => void
    onToggleReasoningLevel: (levelId: string, enabled: boolean) => void
}

function ModelSettingRow({
    model,
    isModelEnabled,
    enabledLevels,
    last,
    draggable = true,
    isDragging = false,
    isDragOver = false,
    onDragStart,
    onDragOver,
    onDrop,
    onDragEnd,
    onToggleModel,
    onToggleReasoningLevel,
}: ModelSettingRowProps) {
    const { t } = useTranslation()

    const isReasoningEnabled = (levelId: string) => {
        if (!enabledLevels) return true
        return enabledLevels.includes(levelId)
    }

    const modelDescription = model.description

    return (
        <div
            data-testid={`model-row-${model.id}`}
            draggable={draggable}
            onDragStart={(e) => onDragStart?.(model.id, e)}
            onDragOver={(e) => onDragOver?.(model.id, e)}
            onDrop={(e) => onDrop?.(model.id, e)}
            onDragEnd={onDragEnd}
            className={cn(
                'group/row relative flex items-start gap-3 px-3.5 py-3.5 transition-all',
                !last && 'border-b border-[var(--border-subtle)]',
                !isModelEnabled && 'opacity-60',
                isDragging && 'opacity-30 bg-[var(--bg-sidebar-hover)]',
                isDragOver && 'border-t-2 border-t-[var(--accent-blue)] bg-[var(--accent-blue)]/5',
            )}
        >
            <div
                className={cn(
                    'flex shrink-0 items-center self-center text-[var(--text-muted)] transition-colors',
                    draggable
                        ? 'cursor-grab active:cursor-grabbing hover:text-[var(--text-primary)]'
                        : 'opacity-30 cursor-not-allowed',
                )}
                title={t('settings.models.dragToReorder', { defaultValue: 'Drag to reorder' })}
                aria-hidden
            >
                <GripVertical className="size-4 opacity-50 group-hover/row:opacity-100 transition-opacity" />
            </div>

            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium text-[var(--text-primary)]">
                        {model.label}
                    </span>
                    <span className="rounded border border-[var(--border-subtle)] bg-[var(--bg-sidebar-hover)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--text-muted)]">
                        {model.id}
                    </span>
                </div>

                {modelDescription ? (
                    <div className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
                        {modelDescription}
                    </div>
                ) : null}

                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                        {t('settings.models.reasoningLevels', { defaultValue: 'Reasoning Effort' })}:
                    </span>
                    {model.reasoningLevels.length > 0 ? (
                        model.reasoningLevels.map((option) => {
                            const isChecked = isReasoningEnabled(option.id)
                            return (
                                <button
                                    key={option.id}
                                    type="button"
                                    role="checkbox"
                                    aria-checked={isChecked}
                                    disabled={!isModelEnabled}
                                    onClick={() => onToggleReasoningLevel(option.id, !isChecked)}
                                    className={cn(
                                        'inline-flex items-center rounded-md border px-2 py-1 text-[11px] font-medium transition-all select-none',
                                        !isModelEnabled
                                            ? 'cursor-not-allowed border-[var(--border-subtle)] bg-[var(--bg-sidebar-hover)] text-[var(--text-muted)] opacity-50'
                                            : isChecked
                                              ? 'border-[var(--accent-blue)]/40 bg-[var(--accent-blue)]/15 text-[var(--accent-blue)] hover:bg-[var(--accent-blue)]/20 cursor-pointer'
                                              : 'border-[var(--border-subtle)] bg-[var(--bg-sidebar-hover)] text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)]/80 hover:text-[var(--text-secondary)] cursor-pointer',
                                    )}
                                >
                                    <span>{getReasoningLabel(t, option)}</span>
                                </button>
                            )
                        })
                    ) : (
                        <span className="text-[11px] text-[var(--text-muted)]">
                            {t('settings.models.noReasoningLevels', {
                                defaultValue: 'No reasoning levels',
                            })}
                        </span>
                    )}
                </div>
            </div>

            <div className="flex shrink-0 items-center pt-0.5">
                <ToggleSwitch
                    checked={isModelEnabled}
                    onChange={onToggleModel}
                    label={t('settings.models.enableModel', {
                        defaultValue: `Enable ${model.label}`,
                        name: model.label,
                    })}
                />
            </div>
        </div>
    )
}
