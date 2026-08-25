import { Check, cn, useTranslation } from '@cpa/plugin-ui'
import type { ModelReasoningOption } from '@cpa/plugin-api'

export interface ReasoningMenuProps {
    options: readonly ModelReasoningOption[]
    reasoningLevel: string
    onSelect: (reasoningLevel: string) => void
    id?: string
    maxHeight?: number
    disabled?: boolean
}

export function ReasoningMenu({
    options,
    reasoningLevel,
    onSelect,
    id = 'composer-reasoning-submenu',
    maxHeight,
    disabled = false,
}: ReasoningMenuProps) {
    const { t } = useTranslation()
    const titleId = `${id}-title`

    return (
        <div
            id={id}
            role="menu"
            aria-label={t('composer.reasoning', { defaultValue: 'Reasoning Effort' })}
            aria-labelledby={titleId}
            aria-disabled={disabled || undefined}
            style={{
                maxWidth: '100%',
                maxHeight: maxHeight && maxHeight > 0 ? `${maxHeight}px` : undefined,
            }}
            className="w-[190px] overflow-y-auto rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-1.5 shadow-lg"
        >
            <h2
                id={titleId}
                className="m-0 px-2 pb-1.5 pt-0.5 text-[11px] font-medium leading-4 text-[var(--text-secondary)]"
            >
                {t('composer.reasoning', { defaultValue: 'Reasoning Effort' })}
            </h2>
            {options.length > 0 ? (
                options.map((option) => {
                    const selected = option.id === reasoningLevel
                    const label = option.labelKey
                        ? t(option.labelKey, { defaultValue: option.fallbackLabel ?? option.id })
                        : option.fallbackLabel ?? option.id
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
                                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]',
                                'transition-colors hover:bg-[var(--bg-sidebar-hover)]',
                                'disabled:pointer-events-none disabled:opacity-50',
                                selected
                                    ? 'text-[var(--text-primary)]'
                                    : 'text-[var(--text-secondary)]',
                            )}
                        >
                            <span className="min-w-0 flex-1">{label}</span>
                            {selected ? (
                                <Check className="size-4 shrink-0 text-[var(--accent-blue)]" aria-hidden />
                            ) : null}
                        </button>
                    )
                })
            ) : (
                <div className="px-2 py-2 text-[12px] text-[var(--text-muted)]">
                    {t('composer.modelCatalog.unavailable', { defaultValue: 'Unavailable' })}
                </div>
            )}
        </div>
    )
}
