import { cn, useHostService, useTranslation, FileText, PanelLeft } from '@cpa/plugin-ui'
import { UiServiceToken } from '@cpa/plugin-api'
import { isBrowserEnvironment } from '../utils/platform.js'

export interface TitleBarSlotProps {
    leftSidebarCollapsed?: boolean
    showPinnedSummaryToggle?: boolean
    reserveWindowToolbar?: boolean
    sessionTitle?: string | null
}

export function TitleBarLeftContribution({ leftSidebarCollapsed }: TitleBarSlotProps) {
    const { t } = useTranslation()
    const uiService = useHostService(UiServiceToken)

    if (!leftSidebarCollapsed) {
        return null
    }

    const isBrowser = isBrowserEnvironment()

    const handleToggle = () => {
        uiService?.toggleSidebar?.()
    }

    return (
        <div className="flex items-center">
            {!isBrowser ? (
                <div
                    aria-hidden
                    className="h-full shrink-0"
                    style={{ width: 'var(--traffic-lights-pad)' }}
                    data-drag-region
                />
            ) : null}
            <div className={cn('flex -translate-y-px items-center pr-1', isBrowser && 'pl-2.5')}>
                <button
                    type="button"
                    aria-label={t('nav.expandSidebar')}
                    title={t('nav.expandSidebar')}
                    className={cn(
                        'flex size-6 shrink-0 items-center justify-center rounded-md',
                        'text-[var(--text-muted)] transition-colors',
                        'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-subtle)]',
                    )}
                    onClick={handleToggle}
                >
                    <PanelLeft className="size-3.5" strokeWidth={1.75} aria-hidden />
                </button>
            </div>
        </div>
    )
}

export function TitleBarCenterContribution({ sessionTitle }: TitleBarSlotProps) {
    if (!sessionTitle) {
        return null
    }

    return (
        <div className="flex min-w-0 items-center gap-1.5">
            <FileText
                className="size-3.5 shrink-0 text-[var(--text-muted)]"
                strokeWidth={1.75}
                aria-hidden
            />
            <span className="truncate text-[13px] text-[var(--text-secondary)]">
                {sessionTitle}
            </span>
        </div>
    )
}

export function TitleBarRightContribution({
    showPinnedSummaryToggle,
    reserveWindowToolbar,
}: TitleBarSlotProps) {
    const { t } = useTranslation()
    const uiService = useHostService(UiServiceToken)

    const handlePinnedToggle = (e: any) => {
        e.stopPropagation?.()
        uiService?.togglePinnedSummaryVisible?.()
    }

    return (
        <div className="flex shrink-0 items-center">
            {showPinnedSummaryToggle ? (
                <button
                    type="button"
                    data-testid="pinned-summary-toggle"
                    aria-label={t('nav.showPinnedSummary')}
                    title={t('nav.showPinnedSummary')}
                    onClick={handlePinnedToggle}
                    className={cn(
                        'inline-flex size-6 shrink-0 items-center justify-center rounded-lg leading-none',
                        'text-[var(--text-muted)] transition-colors',
                        'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                    )}
                >
                    <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
                        <circle cx="3.1" cy="5" r="1.35" fill="currentColor" />
                        <rect x="6.1" y="4.25" width="7.1" height="1.5" rx="0.75" fill="currentColor" />
                        <circle cx="3.1" cy="11" r="1.35" fill="currentColor" />
                        <rect x="6.1" y="10.25" width="7.1" height="1.5" rx="0.75" fill="currentColor" />
                    </svg>
                </button>
            ) : null}
            {reserveWindowToolbar ? (
                <div
                    aria-hidden
                    className="shrink-0"
                    style={{ width: 84 }}
                />
            ) : null}
        </div>
    )
}
