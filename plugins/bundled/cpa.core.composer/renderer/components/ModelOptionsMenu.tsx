import { useMemo } from 'react'
import { Check, ChevronRight, cn, useTranslation } from '@cpa/plugin-ui'
import type { ModelCatalogEntry } from '@cpa/plugin-api'
import { sortModelsByName } from '../utils/modelMenuOptions.js'
import { groupGemini4Models, resolveGemini4Element } from '../utils/gemini4PeriodicTable.js'

export interface ModelOptionsMenuProps {
    models: readonly ModelCatalogEntry[]
    modelId: string
    onSelect: (modelId: string) => void
    enableGemini4Grouping?: boolean
    onOpenGemini4Group?: () => void
    id?: string
    ariaLabelledBy?: string
    maxHeight?: number
    disabled?: boolean
}

type ModelMenuRow =
    | { kind: 'model'; model: ModelCatalogEntry }
    | { kind: 'gemini4-group'; label: string; releasedCount: number; containsCurrent: boolean; activeSymbol: string | null }

export function ModelOptionsMenu({
    models,
    modelId,
    onSelect,
    enableGemini4Grouping = false,
    onOpenGemini4Group,
    id,
    ariaLabelledBy,
    maxHeight,
    disabled = false,
}: ModelOptionsMenuProps) {
    const { t } = useTranslation()

    const rows = useMemo<ModelMenuRow[]>(() => {
        const grouped = groupGemini4Models(models)
        const shouldGroup =
            Boolean(enableGemini4Grouping && onOpenGemini4Group) && grouped.gemini4Models.length > 0

        if (!shouldGroup) {
            return sortModelsByName(models).map((model) => ({ kind: 'model', model }))
        }

        const regularRows: ModelMenuRow[] = sortModelsByName(grouped.nonGemini4Models).map(
            (model) => ({ kind: 'model', model }),
        )

        const groupLabel = t('composer.gemini4PeriodicTable.groupLabel', {
            defaultValue: 'Gemini 4',
        })
        const currentGemini4Model = grouped.gemini4Models.find((m) => m.id === modelId)
        const activeElement = currentGemini4Model
            ? resolveGemini4Element(currentGemini4Model)
            : null
        const groupRow: ModelMenuRow = {
            kind: 'gemini4-group',
            label: groupLabel,
            releasedCount: grouped.releasedCount,
            containsCurrent: Boolean(currentGemini4Model),
            activeSymbol: activeElement?.symbol ?? null,
        }

        const insertIndex = regularRows.findIndex((row) => {
            if (row.kind !== 'model') return false
            const rowLabel = row.model.label || row.model.id
            return rowLabel.localeCompare(groupLabel, undefined, { numeric: true, sensitivity: 'base' }) > 0
        })
        if (insertIndex === -1) {
            regularRows.push(groupRow)
        } else {
            regularRows.splice(insertIndex, 0, groupRow)
        }
        return regularRows
    }, [models, enableGemini4Grouping, onOpenGemini4Group, modelId, t])

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
            className="w-[190px] overflow-y-auto rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-1.5 font-[inherit] shadow-lg"
        >
            {rows.length > 0 ? (
                rows.map((row) => {
                    if (row.kind === 'gemini4-group') {
                        return (
                            <button
                                key="__gemini4_group__"
                                type="button"
                                role="menuitem"
                                aria-haspopup="dialog"
                                disabled={disabled}
                                aria-disabled={disabled || undefined}
                                onClick={() => {
                                    if (disabled) return
                                    onOpenGemini4Group?.()
                                }}
                                className={cn(
                                    'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[13px]',
                                    'transition-colors hover:bg-[var(--bg-sidebar-hover)]',
                                    'disabled:pointer-events-none disabled:opacity-50',
                                    row.containsCurrent
                                        ? 'text-[var(--text-primary)]'
                                        : 'text-[var(--text-secondary)]',
                                )}
                            >
                                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                                {row.activeSymbol ? (
                                    <span className="rounded px-1 py-0.5 text-[10px] font-medium bg-[var(--accent-blue)]/15 text-[var(--accent-blue)]">
                                        {row.activeSymbol}
                                    </span>
                                ) : null}
                                <span
                                    data-testid="gemini4-group-released-count"
                                    className="rounded px-1 py-0.5 text-[10px] font-medium bg-[var(--bg-sidebar-hover)] text-[var(--text-muted)]"
                                >
                                    {row.releasedCount}
                                </span>
                                {row.containsCurrent ? (
                                    <Check
                                        className="size-3.5 shrink-0 text-[var(--accent-blue)]"
                                        aria-hidden
                                    />
                                ) : null}
                                <ChevronRight
                                    className="size-3.5 shrink-0 text-[var(--text-muted)]"
                                    aria-hidden
                                />
                            </button>
                        )
                    }

                    const option = row.model
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
