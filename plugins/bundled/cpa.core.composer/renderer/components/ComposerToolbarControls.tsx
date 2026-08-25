import { Plus, cn, useHostServices, useSettings, useTranslation } from '@cpa/plugin-ui'
import type { ComposerControlProps } from '@cpa/plugin-api'

export function AttachControl({ disabled, ...props }: ComposerControlProps) {
    const { t } = useTranslation()

    const handleClick = () => {
        if (typeof props.onToggleAttachMenu === 'function') {
            ;(props.onToggleAttachMenu as () => void)()
        }
    }

    return (
        <button
            type="button"
            aria-label={t('composer.attach', { defaultValue: 'Attach' })}
            disabled={disabled}
            aria-disabled={disabled}
            onClick={handleClick}
            className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-md',
                'text-[var(--text-muted)] transition-colors',
                'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                'disabled:pointer-events-none disabled:opacity-50',
            )}
        >
            <Plus className="size-4" />
        </button>
    )
}

export function RequestApprovalControl({ disabled }: ComposerControlProps) {
    const { t } = useTranslation()
    const services = useHostServices()
    const settings = useSettings()
    const requestApproval = settings.requestApproval ?? false

    return (
        <label
            className={cn(
                'ml-0.5 flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1',
                'text-[12px] text-[var(--text-secondary)] transition-colors',
                'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                disabled && 'pointer-events-none opacity-60',
            )}
        >
            <input
                type="checkbox"
                className="size-3.5 accent-[var(--accent-blue)]"
                checked={requestApproval}
                disabled={disabled}
                onChange={(event) => services?.settings?.setRequestApproval?.(event.target.checked)}
            />
            <span className="select-none whitespace-nowrap">
                {t('composer.requestApproval', { defaultValue: 'Request approval' })}
            </span>
        </label>
    )
}
