import { useMemo } from 'react'
import { Check, cn, useTranslation } from '@cpa/plugin-ui'
import type { ModelCatalogEntry } from '@cpa/plugin-api'
import { sortModelsByName } from '../utils/modelMenuOptions.js'

export interface ModelOptionsMenuProps {
    models: readonly ModelCatalogEntry[]
    modelId: string
    onSelect: (modelId: string) => void
    id?: string
    ariaLabelledBy?: string
    maxHeight?: number
    disabled?: boolean
}

export function ModelOptionsMenu({
    models,
    modelId,
    onSelect,
    id,
    ariaLabelledBy,
    maxHeight,
    disabled = false,
}: ModelOptionsMenuProps) {
    const { t } = useTranslation()
    const sortedModels = useMemo(() => sortModelsByName(models), [models])

    return (
        <div
            id={id}
            role="menu"
            aria-label={t('composer.modelOptions', { defaultValue: 'Model options' })}
            aria-labelledby={ariaLabelledBy}
            aria-disabled={disabled || undefined}
            style={{
                maxWidth: '100%',
                maxHeight: maxHeight && maxHeight > 0 ? `${maxHeight}px` : undefined,
            }}
            className="w-[190px] overflow-y-auto rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-1.5 shadow-lg"
        >
            {sortedModels.length > 0 ? (
                sortedModels.map((option) => {
                    const selected = option.id === modelId
                    return (
                        <button
                            key={option.id}
                            type="button"
                            role="menuitemradio"
                            aria-checked={selected}
                            disabled={disabled}
                            aria-disabled={disabled || undefined}
                            onClick={() => {
                                if (disabled) return
                                onSelect(option.id)
                            }}
                            className={cn(
                                'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[13px]',
                                'transition-colors hover:bg-[var(--bg-sidebar-hover)]',
                                'disabled:pointer-events-none disabled:opacity-50',
                                selected
                                    ? 'text-[var(--text-primary)]'
                                    : 'text-[var(--text-secondary)]',
                            )}
                        >
                            <span className="min-w-0 flex-1 truncate">{option.label || option.id}</span>
                            {selected ? (
                                <Check className="size-4 shrink-0 text-[var(--accent-blue)]" aria-hidden />
                            ) : null}
                        </button>
                    )
                })
            ) : (
                <div className="px-2 py-2 text-[12px] text-[var(--text-muted)]">
                    {t('composer.modelCatalog.noModels', { defaultValue: 'No models available' })}
                </div>
            )}
        </div>
    )
}
