import { Check, cn, useTranslation } from '@cpa/plugin-ui'
import type { Speed } from '@cpa/plugin-api'
import type { SpeedOption } from '../utils/modelMenuOptions.js'

export interface SpeedMenuProps {
    options: readonly SpeedOption[]
    speed: Speed
    onSelect: (speed: Speed) => void
    id?: string
    ariaLabelledBy?: string
    maxHeight?: number
    disabled?: boolean
}

export function SpeedMenu({
    options,
    speed,
    onSelect,
    id,
    ariaLabelledBy,
    maxHeight,
    disabled = false,
}: SpeedMenuProps) {
    const { t } = useTranslation()

    return (
        <div
            id={id}
            role="menu"
            aria-label={t('composer.speed', { defaultValue: 'Speed' })}
            aria-labelledby={ariaLabelledBy}
            aria-disabled={disabled || undefined}
            style={{
                maxWidth: '100%',
                maxHeight: maxHeight && maxHeight > 0 ? `${maxHeight}px` : undefined,
            }}
            className="w-[190px] overflow-y-auto rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-1.5 shadow-lg"
        >
            {options.map((option) => {
                const selected = option.id === speed
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
                        <span className="flex-1">{t(option.labelKey, { defaultValue: option.id })}</span>
                        {selected ? (
                            <Check className="size-4 shrink-0 text-[var(--accent-blue)]" aria-hidden />
                        ) : null}
                    </button>
                )
            })}
        </div>
    )
}
