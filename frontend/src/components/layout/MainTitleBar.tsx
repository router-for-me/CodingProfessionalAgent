import { FileText } from 'lucide-react'
import { ExtensionSlot } from '@/plugins/registry/ExtensionSlot'
import { cn } from '@/lib/cn'
import { isBrowserEnvironment } from '@/lib/platform'
import { SidebarToggle } from './SidebarToggle'
import {
    PinnedSummaryToggle,
    WINDOW_TOOLBAR_THREE_WIDTH,
} from './WindowToolbar'

export interface MainTitleBarProps {
    leftSidebarCollapsed: boolean
    /** When the right sidebar is open, the summary toggle lives here. */
    showPinnedSummaryToggle: boolean
    /** When the right sidebar is closed, reserve room for the window-edge trio. */
    reserveWindowToolbar: boolean
    sessionTitle?: string | null
}

/**
 * Main-column title strip hosting extension slots for left, center, and right sections:
 * session name, optional left-sidebar toggle, and pinned-summary control.
 */
export function MainTitleBar({
    leftSidebarCollapsed,
    showPinnedSummaryToggle,
    reserveWindowToolbar,
    sessionTitle,
}: MainTitleBarProps) {
    const slotProps: MainTitleBarProps = {
        leftSidebarCollapsed,
        showPinnedSummaryToggle,
        reserveWindowToolbar,
        sessionTitle,
    }
    const isBrowser = isBrowserEnvironment()

    return (
        <div
            data-testid="main-titlebar"
            data-drag-region
            className="flex h-[var(--titlebar-height)] shrink-0 items-center"
        >
            <ExtensionSlot
                name="layout.titlebar.left"
                props={slotProps}
                fallback={
                    leftSidebarCollapsed ? (
                        <>
                            {!isBrowser ? (
                                <div
                                    aria-hidden
                                    className="h-full shrink-0"
                                    style={{ width: 'var(--traffic-lights-pad)' }}
                                    data-drag-region
                                />
                            ) : null}
                            <div className={cn('flex -translate-y-px items-center pr-1', isBrowser && 'pl-2.5')}>
                                <SidebarToggle />
                            </div>
                        </>
                    ) : null
                }
            />

            <div className="flex min-w-0 flex-1 -translate-y-0.5 items-center gap-1.5 px-3">
                <ExtensionSlot
                    name="layout.titlebar.center"
                    props={slotProps}
                    fallback={
                        sessionTitle ? (
                            <>
                                <FileText
                                    className="size-3.5 shrink-0 text-[var(--text-muted)]"
                                    strokeWidth={1.75}
                                    aria-hidden
                                />
                                <span className="truncate text-[13px] text-[var(--text-secondary)]">
                                    {sessionTitle}
                                </span>
                            </>
                        ) : null
                    }
                />
            </div>

            <div className="flex shrink-0 -translate-y-px items-center pr-2">
                <ExtensionSlot
                    name="layout.titlebar.right"
                    props={slotProps}
                    fallback={
                        <>
                            {showPinnedSummaryToggle ? (
                                <PinnedSummaryToggle />
                            ) : null}
                            {reserveWindowToolbar ? (
                                <div
                                    aria-hidden
                                    className="shrink-0"
                                    style={{ width: WINDOW_TOOLBAR_THREE_WIDTH }}
                                />
                            ) : null}
                        </>
                    }
                />
            </div>
        </div>
    )
}
