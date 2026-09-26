import { useEffect, useMemo, useRef, type MouseEvent } from 'react'
import { Check, cn, useTranslation, useWorkspaceVisible } from '@cpa/plugin-ui'
import type { ModelCatalogEntry } from '@cpa/plugin-api'
import { sortModelsByName } from '../utils/modelMenuOptions.js'

export interface QuickModelPickerProps {
    models: readonly ModelCatalogEntry[]
    currentModelId: string
    activeIndex: number
    onActiveIndexChange: (index: number) => void
    onSelect: (model: ModelCatalogEntry) => void
    onClose: () => void
    id?: string
    className?: string
}

export const QUICK_MODEL_PICKER_ID = 'composer-quick-model-picker'

/**
 * Floating quick model picker menu displayed above the Composer input shell.
 * Allows interactive search, arrow navigation, and instant model switching.
 */
export function QuickModelPicker({
    models,
    currentModelId,
    activeIndex,
    onActiveIndexChange,
    onSelect,
    onClose,
    id = QUICK_MODEL_PICKER_ID,
    className,
}: QuickModelPickerProps) {
    const { t } = useTranslation()
    const workspaceVisible = useWorkspaceVisible()
    const listRef = useRef<HTMLDivElement>(null)

    const sortedModels = useMemo(() => sortModelsByName(models), [models])

    const safeIndex =
        sortedModels.length > 0
            ? ((activeIndex % sortedModels.length) + sortedModels.length) % sortedModels.length
            : 0

    // Auto scroll active item into view
    useEffect(() => {
        if (!workspaceVisible || !listRef.current || sortedModels.length === 0) return
        const activeElem = listRef.current.querySelector(
            `[data-model-index="${safeIndex}"]`,
        ) as HTMLElement | null
        if (activeElem && typeof activeElem.scrollIntoView === 'function') {
            activeElem.scrollIntoView({ block: 'nearest' })
        }
    }, [safeIndex, sortedModels.length, workspaceVisible])

    // Close when clicking outside of composer
    useEffect(() => {
        if (!workspaceVisible) return
        const onPointerDown = (event: PointerEvent) => {
            const target = event.target as HTMLElement | null
            if (
                listRef.current?.contains(target as Node) ||
                target?.closest('[data-element="composer-container"]')
            ) {
                return
            }
            onClose()
        }
        document.addEventListener('pointerdown', onPointerDown)
        return () => {
            document.removeEventListener('pointerdown', onPointerDown)
        }
    }, [onClose, workspaceVisible])

    return (
        <div
            id={id}
            ref={listRef}
            role="listbox"
            tabIndex={-1}
            aria-label={t('shortcuts.item.openModelSelector.title', { defaultValue: 'Quick model selector' })}
            className={cn(
                'absolute bottom-full left-0 right-0 z-[60] mb-2.5 max-h-80 overflow-y-auto',
                'rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/95',
                'p-1.5 shadow-2xl backdrop-blur-xl',
                className,
            )}
        >
            {sortedModels.length === 0 ? (
                <div className="py-6 text-center text-[13px] text-[var(--text-muted)]">
                    {t('settings.models.searchEmpty', { defaultValue: 'No matching models found' })}
                </div>
            ) : (
                <div className="flex flex-col gap-0.5">
                    {sortedModels.map((model, index) => {
                        const isSelected = index === safeIndex
                        const isCurrent = model.id === currentModelId
                        const description = model.description || model.id
                        const label = model.label || model.id

                        return (
                            <button
                                key={model.id}
                                id={`${id}-opt-${model.id}`}
                                data-model-index={index}
                                type="button"
                                role="option"
                                aria-selected={isSelected}
                                onMouseDown={(event: MouseEvent<HTMLButtonElement>) => {
                                    event.preventDefault()
                                    onSelect(model)
                                }}
                                onMouseEnter={() => onActiveIndexChange(index)}
                                className={cn(
                                    'flex w-full items-center justify-between gap-4 px-3.5 py-2.5 rounded-xl',
                                    'text-left transition-colors cursor-pointer select-none',
                                    isSelected
                                        ? 'bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)]'
                                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                                )}
                            >
                                {/* Left: Model Name */}
                                <span className="font-medium text-[13.5px] text-[var(--text-primary)] whitespace-nowrap">
                                    {label}
                                </span>

                                {/* Right: Description and Checkmark */}
                                <div className="flex min-w-0 flex-1 items-center justify-end gap-2 text-right">
                                    <span className="truncate text-[12.5px] text-[var(--text-muted)] max-w-[340px]">
                                        {description}
                                    </span>
                                    {isCurrent ? (
                                        <Check
                                            className="size-4 shrink-0 text-[var(--text-primary)] opacity-90"
                                            aria-hidden
                                        />
                                    ) : (
                                        <div className="size-4 shrink-0" aria-hidden />
                                    )}
                                </div>
                            </button>
                        )
                    })}
                </div>
            )}
        </div>
    )
}
