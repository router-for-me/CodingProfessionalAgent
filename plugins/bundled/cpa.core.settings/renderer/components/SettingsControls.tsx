import { useEffect, useState, type ReactNode } from 'react'
import {
    Check,
    CustomSelect,
    Eye,
    EyeOff,
    X,
    cn,
    useTranslation,
} from '@cpa/plugin-ui'

/**
 * Single settings row: title + description on the left, control on the right.
 */
export function SettingsRow({
    id,
    title,
    description,
    control,
    last = false,
}: {
    id?: string
    title: string
    description?: ReactNode
    control: ReactNode
    last?: boolean
}) {
    return (
        <div
            id={id}
            data-setting-id={id}
            className={cn(
                'flex items-start gap-4 px-3.5 py-3 transition-colors duration-300',
                !last && 'border-b border-[var(--border-subtle)]',
            )}
        >
            <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-[var(--text-primary)]">
                    {title}
                </div>
                {description ? (
                    <div className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-muted)]">
                        {description}
                    </div>
                ) : null}
            </div>
            <div className="flex shrink-0 items-center pt-0.5">{control}</div>
        </div>
    )
}

/** Grouped card containing multiple settings rows. */
export function SettingsCard({ children }: { children: ReactNode }) {
    return (
        <div className="overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)]">
            {children}
        </div>
    )
}

export function SettingsSection({
    id,
    title,
    children,
}: {
    id?: string
    title: string
    children: ReactNode
}) {
    return (
        <section id={id} data-setting-id={id} className="space-y-2">
            <h3 className="px-0.5 text-[12px] font-medium text-[var(--text-secondary)]">
                {title}
            </h3>
            {children}
        </section>
    )
}

/** iOS-style switch. Track 40×22, thumb 18, inset 2 → travel 18px. */
export function ToggleSwitch({
    checked,
    onChange,
    label,
    disabled = false,
}: {
    checked: boolean
    onChange: (next: boolean) => void
    label: string
    disabled?: boolean
}) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            disabled={disabled}
            aria-disabled={disabled}
            className={cn(
                'relative inline-flex h-[22px] w-[40px] shrink-0 items-center overflow-hidden rounded-full p-[2px] transition-colors',
                'border-0 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                checked ? 'bg-[var(--accent-blue)]' : 'bg-[var(--text-muted)]/35',
            )}
            style={{
                backgroundColor: checked ? 'var(--accent-blue)' : undefined,
            }}
            onClick={() => {
                if (!disabled) {
                    onChange(!checked)
                }
            }}
        >
            <span
                className={cn(
                    'pointer-events-none block size-[18px] rounded-full bg-white shadow-sm transition-transform duration-150 ease-out',
                    checked ? 'translate-x-[18px]' : 'translate-x-0',
                )}
            />
        </button>
    )
}

/** Compact text input used in settings rows. */
export function SettingsTextInput({
    value,
    onChange,
    onConfirm,
    onCancel,
    confirmable = false,
    type = 'text',
    ariaLabel,
    placeholder,
    autoComplete,
}: {
    value: string
    onChange?: (value: string) => void
    onConfirm?: (value: string) => void
    onCancel?: () => void
    confirmable?: boolean
    type?: 'text' | 'url' | 'password'
    ariaLabel: string
    placeholder: string
    autoComplete: string
}) {
    const { t } = useTranslation()
    const [draft, setDraft] = useState(value)

    useEffect(() => {
        setDraft(value)
    }, [value])

    if (!confirmable) {
        return (
            <input
                type={type}
                aria-label={ariaLabel}
                value={value}
                placeholder={placeholder}
                autoComplete={autoComplete}
                className={cn(
                    'w-[260px] rounded-lg border border-[var(--border-subtle)]',
                    'bg-[var(--bg-sidebar-hover)] px-2.5 py-1.5 text-[12px]',
                    'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
                    'outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                )}
                onChange={(event) => onChange?.(event.target.value)}
            />
        )
    }

    const isDirty = draft !== value

    const handleCommit = () => {
        const trimmed = draft.trim()
        if (!trimmed) {
            setDraft(value)
            return
        }
        if (onConfirm) {
            onConfirm(trimmed)
        } else if (onChange) {
            onChange(trimmed)
        }
    }

    const handleCancel = () => {
        setDraft(value)
        onCancel?.()
    }

    return (
        <div className="relative inline-flex items-center">
            <input
                type={type}
                aria-label={ariaLabel}
                value={draft}
                placeholder={placeholder}
                autoComplete={autoComplete}
                className={cn(
                    'w-[260px] rounded-lg border border-[var(--border-subtle)]',
                    'bg-[var(--bg-sidebar-hover)] px-2.5 py-1.5 text-[12px]',
                    'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
                    'outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                    isDirty && 'pr-14',
                )}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                        event.preventDefault()
                        handleCommit()
                    } else if (event.key === 'Escape') {
                        event.preventDefault()
                        handleCancel()
                    }
                }}
            />
            {isDirty && (
                <div className="absolute right-1.5 flex items-center gap-0.5">
                    <button
                        type="button"
                        title={t('common.confirm', 'Confirm')}
                        aria-label={t('common.confirm', 'Confirm')}
                        className={cn(
                            'flex size-5 items-center justify-center rounded transition-colors',
                            'text-[var(--text-muted)] hover:bg-emerald-500/15 hover:text-emerald-500',
                            'active:scale-95 cursor-pointer',
                        )}
                        onClick={handleCommit}
                    >
                        <Check className="size-3.5" />
                    </button>
                    <button
                        type="button"
                        title={t('common.cancel', 'Cancel')}
                        aria-label={t('common.cancel', 'Cancel')}
                        className={cn(
                            'flex size-5 items-center justify-center rounded transition-colors',
                            'text-[var(--text-muted)] hover:bg-rose-500/15 hover:text-rose-500',
                            'active:scale-95 cursor-pointer',
                        )}
                        onClick={handleCancel}
                    >
                        <X className="size-3.5" />
                    </button>
                </div>
            )}
        </div>
    )
}

/** Compact password input with show/hide toggle and optional confirmable actions. */
export function SettingsPasswordInput({
    value,
    onChange,
    onConfirm,
    confirmable = false,
    ariaLabel,
    placeholder,
    showLabel,
    hideLabel,
}: {
    value: string
    onChange?: (value: string) => void
    onConfirm?: (value: string) => void
    confirmable?: boolean
    ariaLabel: string
    placeholder: string
    showLabel: string
    hideLabel: string
}) {
    const { t } = useTranslation()
    const [draft, setDraft] = useState(value)
    const [visible, setVisible] = useState(false)

    useEffect(() => {
        setDraft(value)
    }, [value])

    if (!confirmable) {
        return (
            <div className="relative inline-flex items-center">
                <input
                    type={visible ? 'text' : 'password'}
                    aria-label={ariaLabel}
                    autoComplete="new-password"
                    value={value}
                    placeholder={placeholder}
                    className={cn(
                        'w-[260px] rounded-lg border border-[var(--border-subtle)]',
                        'bg-[var(--bg-sidebar-hover)] py-1.5 pl-2.5 font-[inherit] text-[length:var(--ui-font-size)]',
                        'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
                        'outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                        'pr-[32px]',
                    )}
                    onChange={(event) => {
                        onChange?.(event.target.value)
                        onConfirm?.(event.target.value)
                    }}
                />
                <button
                    type="button"
                    aria-label={visible ? hideLabel : showLabel}
                    className={cn(
                        'absolute right-1 flex size-6 items-center justify-center rounded transition-colors',
                        'text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer',
                    )}
                    onClick={() => setVisible((current) => !current)}
                >
                    {visible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </button>
            </div>
        )
    }

    const dirty = draft !== value
    const confirm = () => {
        onConfirm?.(draft)
        onChange?.(draft)
    }
    const cancel = () => setDraft(value)

    return (
        <div className="relative inline-flex items-center">
            <input
                type={visible ? 'text' : 'password'}
                aria-label={ariaLabel}
                autoComplete="new-password"
                value={draft}
                placeholder={placeholder}
                className={cn(
                    'w-[260px] rounded-lg border border-[var(--border-subtle)]',
                    'bg-[var(--bg-sidebar-hover)] py-1.5 pl-2.5 font-[inherit] text-[length:var(--ui-font-size)]',
                    'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
                    'outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                    dirty ? 'pr-[86px]' : 'pr-[32px]',
                )}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                        event.preventDefault()
                        confirm()
                    } else if (event.key === 'Escape') {
                        event.preventDefault()
                        cancel()
                    }
                }}
            />
            <button
                type="button"
                aria-label={visible ? hideLabel : showLabel}
                className={cn(
                    'absolute right-1 flex size-6 items-center justify-center rounded transition-colors',
                    'text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer',
                )}
                onClick={() => setVisible((current) => !current)}
            >
                {visible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
            {dirty ? (
                <div className="absolute right-[30px] flex items-center gap-0.5">
                    <button
                        type="button"
                        title={t('common.confirm', 'Confirm')}
                        aria-label={t('common.confirm', 'Confirm')}
                        className={cn(
                            'flex size-6 items-center justify-center rounded transition-colors',
                            'text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] hover:text-[var(--accent-blue)]',
                            'active:scale-95 cursor-pointer',
                        )}
                        onClick={confirm}
                    >
                        <Check className="size-3.5" />
                    </button>
                    <button
                        type="button"
                        title={t('common.cancel', 'Cancel')}
                        aria-label={t('common.cancel', 'Cancel')}
                        className={cn(
                            'flex size-6 items-center justify-center rounded transition-colors',
                            'text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]',
                            'active:scale-95 cursor-pointer',
                        )}
                        onClick={cancel}
                    >
                        <X className="size-3.5" />
                    </button>
                </div>
            ) : null}
        </div>
    )
}

/** Compact percent input used for numeric settings. */
export function SettingsPercentInput({
    value,
    onChange,
    ariaLabel,
    min,
    max,
}: {
    value: number
    onChange: (value: number) => void
    ariaLabel: string
    min: number
    max: number
}) {
    const [draft, setDraft] = useState(String(value))
    useEffect(() => {
        setDraft(String(value))
    }, [value])

    const commit = () => {
        const next = Number(draft)
        if (!Number.isFinite(next)) {
            setDraft(String(value))
            return
        }
        onChange(next)
    }

    return (
        <label className="flex items-center gap-1.5">
            <input
                type="number"
                inputMode="numeric"
                min={min}
                max={max}
                step={1}
                aria-label={ariaLabel}
                value={draft}
                className={cn(
                    'w-[72px] rounded-lg border border-[var(--border-subtle)]',
                    'bg-[var(--bg-sidebar-hover)] px-2.5 py-1.5 text-right text-[12px]',
                    'text-[var(--text-primary)]',
                    'outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                    '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none',
                    '[&::-webkit-outer-spin-button]:appearance-none',
                )}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commit}
                onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                        event.currentTarget.blur()
                    }
                }}
            />
            <span className="text-[12px] text-[var(--text-muted)]">%</span>
        </label>
    )
}

/** Compact pixel input used for font size settings (e.g. 14 px). */
export function SettingsPixelInput({
    value,
    onChange,
    ariaLabel,
    min = 8,
    max = 32,
}: {
    value: number
    onChange: (value: number) => void
    ariaLabel: string
    min?: number
    max?: number
}) {
    const [draft, setDraft] = useState(String(value))
    useEffect(() => {
        setDraft(String(value))
    }, [value])

    const commit = () => {
        const next = Number(draft)
        if (!Number.isFinite(next)) {
            setDraft(String(value))
            return
        }
        const clamped = Math.max(min, Math.min(max, Math.round(next)))
        onChange(clamped)
        setDraft(String(clamped))
    }

    return (
        <label className="flex items-center gap-1.5 cursor-pointer">
            <input
                type="number"
                inputMode="numeric"
                min={min}
                max={max}
                step={1}
                aria-label={ariaLabel}
                value={draft}
                className={cn(
                    'w-[56px] rounded-lg border border-[var(--border-subtle)]',
                    'bg-[var(--bg-sidebar-hover)] px-2.5 py-1 text-center text-[12px] font-mono',
                    'text-[var(--text-primary)]',
                    'outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                    '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none',
                    '[&::-webkit-outer-spin-button]:appearance-none',
                )}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commit}
                onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                        event.currentTarget.blur()
                    }
                }}
            />
            <span className="text-[12px] text-[var(--text-muted)] select-none">px</span>
        </label>
    )
}

/** Compact port number input used for web server settings. */
export function SettingsPortInput({
    value,
    onChange,
    onConfirm,
    onCancel,
    confirmable = false,
    ariaLabel,
    min = 1,
    max = 65535,
    disabled = false,
}: {
    value: number
    onChange?: (value: number) => void
    onConfirm?: (value: number) => void
    onCancel?: () => void
    confirmable?: boolean
    ariaLabel: string
    min?: number
    max?: number
    disabled?: boolean
}) {
    const { t } = useTranslation()
    const [draft, setDraft] = useState(String(value))
    useEffect(() => {
        setDraft(String(value))
    }, [value])

    const commit = () => {
        const next = Number(draft)
        if (!Number.isFinite(next)) {
            setDraft(String(value))
            return
        }
        const clamped = Math.max(min, Math.min(max, Math.round(next)))
        if (onConfirm) {
            onConfirm(clamped)
        } else if (onChange) {
            onChange(clamped)
        }
        setDraft(String(clamped))
    }

    const cancel = () => {
        setDraft(String(value))
        onCancel?.()
    }

    if (!confirmable) {
        return (
            <input
                type="number"
                inputMode="numeric"
                min={min}
                max={max}
                step={1}
                disabled={disabled}
                aria-label={ariaLabel}
                value={draft}
                className={cn(
                    'w-[120px] rounded-lg border border-[var(--border-subtle)]',
                    'bg-[var(--bg-sidebar-hover)] px-2.5 py-1.5 text-left text-[12px] font-mono',
                    'text-[var(--text-primary)]',
                    'outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                    disabled && 'cursor-not-allowed opacity-60',
                    '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none',
                    '[&::-webkit-outer-spin-button]:appearance-none',
                )}
                onChange={(event) => {
                    const raw = event.target.value
                    setDraft(raw)
                    const next = Number(raw)
                    if (raw.trim() !== '' && Number.isFinite(next)) {
                        const clamped = Math.max(min, Math.min(max, Math.round(next)))
                        onChange?.(clamped)
                        onConfirm?.(clamped)
                    }
                }}
                onBlur={commit}
                onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                        event.currentTarget.blur()
                    }
                }}
            />
        )
    }

    const isDirty = draft !== String(value)

    return (
        <div className="relative inline-flex items-center">
            <input
                type="number"
                inputMode="numeric"
                min={min}
                max={max}
                step={1}
                disabled={disabled}
                aria-label={ariaLabel}
                value={draft}
                className={cn(
                    'w-[120px] rounded-lg border border-[var(--border-subtle)]',
                    'bg-[var(--bg-sidebar-hover)] px-2.5 py-1.5 text-left text-[12px] font-mono',
                    'text-[var(--text-primary)]',
                    'outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                    disabled && 'cursor-not-allowed opacity-60',
                    isDirty && 'pr-13',
                    '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none',
                    '[&::-webkit-outer-spin-button]:appearance-none',
                )}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                        event.preventDefault()
                        commit()
                    } else if (event.key === 'Escape') {
                        event.preventDefault()
                        cancel()
                    }
                }}
            />
            {isDirty && (
                <div className="absolute right-1.5 flex items-center gap-0.5">
                    <button
                        type="button"
                        title={t('common.confirm', 'Confirm')}
                        aria-label={t('common.confirm', 'Confirm')}
                        className={cn(
                            'flex size-5 items-center justify-center rounded transition-colors',
                            'text-[var(--text-muted)] hover:bg-emerald-500/15 hover:text-emerald-500',
                            'active:scale-95 cursor-pointer',
                        )}
                        onClick={commit}
                    >
                        <Check className="size-3.5" />
                    </button>
                    <button
                        type="button"
                        title={t('common.cancel', 'Cancel')}
                        aria-label={t('common.cancel', 'Cancel')}
                        className={cn(
                            'flex size-5 items-center justify-center rounded transition-colors',
                            'text-[var(--text-muted)] hover:bg-rose-500/15 hover:text-rose-500',
                            'active:scale-95 cursor-pointer',
                        )}
                        onClick={cancel}
                    >
                        <X className="size-3.5" />
                    </button>
                </div>
            )}
        </div>
    )
}

/** Compact custom dropdown used in settings rows. */
export function SettingsSelect<T extends string>({
    value,
    options,
    onChange,
    ariaLabel,
}: {
    value: T
    options: { value: T; label: string }[]
    onChange: (value: T) => void
    ariaLabel: string
}) {
    return (
        <CustomSelect
            value={value}
            options={options}
            onChange={onChange}
            ariaLabel={ariaLabel}
            triggerClassName={cn(
                'rounded-lg border border-[var(--border-subtle)]',
                'bg-[var(--bg-sidebar-hover)] py-1.5 pl-2.5 pr-2 text-[12px]',
                'text-[var(--text-primary)]',
                'focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
            )}
        />
    )
}

/** Two-option segmented control (e.g. bottom / right). */
export function SegmentedControl<T extends string>({
    value,
    options,
    onChange,
    ariaLabel,
}: {
    value: T
    options: { value: T; label: string }[]
    onChange: (value: T) => void
    ariaLabel: string
}) {
    return (
        <div
            role="radiogroup"
            aria-label={ariaLabel}
            className="inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sidebar)] p-0.5"
        >
            {options.map((option) => {
                const selected = option.value === value
                return (
                    <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={cn(
                            'rounded-md px-2.5 py-1 text-[12px] transition-colors',
                            selected
                                ? 'bg-[var(--bg-sidebar-hover)] font-medium text-[var(--text-primary)]'
                                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
                        )}
                        onClick={() => onChange(option.value)}
                    >
                        {option.label}
                    </button>
                )
            })}
        </div>
    )
}

/** Inline text link used inside setting descriptions. */
export function SettingsLink({
    children,
    onClick,
}: {
    children: ReactNode
    onClick?: () => void
}) {
    return (
        <button
            type="button"
            className="text-[var(--accent-blue)] hover:underline"
            onClick={onClick}
        >
            {children}
        </button>
    )
}
