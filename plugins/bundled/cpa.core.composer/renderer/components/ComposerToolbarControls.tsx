import { Plus, cn, useTranslation } from '@cpa/plugin-ui'
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

