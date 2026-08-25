import { cn } from './cn.js'

export interface ToggleSwitchProps {
    checked: boolean
    onChange: (next: boolean) => void
    label: string
    disabled?: boolean
}

/**
 * Platform-styled accessible iOS-like toggle switch control.
 */
export function ToggleSwitch({
    checked,
    onChange,
    label,
    disabled = false,
}: ToggleSwitchProps) {
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
