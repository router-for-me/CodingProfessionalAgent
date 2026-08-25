import { useCallback, useMemo } from 'react'
import { SquareTerminal, X, cn, useHostServices, useTranslation } from '@cpa/plugin-ui'
import { useTerminalStore } from '../stores/terminalStore.js'

export interface TerminalTabHeadersProps {
    sessionId?: string | null
    active?: boolean
}

export function TerminalTabHeaders({ sessionId: _sessionId }: TerminalTabHeadersProps) {
    const { t } = useTranslation()
    const services = useHostServices()
    const allTerminalTabs = useTerminalStore((state) => state.tabs)
    const rightTabs = useMemo(
        () => allTerminalTabs.filter((tab) => tab.location === 'right'),
        [allTerminalTabs],
    )
    const activeTabIdByLocation = useTerminalStore((state) => state.activeTabIdByLocation)
    const globalActiveTabId = useTerminalStore((state) => state.activeTabId)
    const activeRightTabId =
        activeTabIdByLocation?.right ??
        rightTabs.find((tab) => tab.id === globalActiveTabId)?.id ??
        rightTabs[rightTabs.length - 1]?.id ??
        null

    const closeTerminalTab = useTerminalStore((state) => state.closeTab)
    const setActiveTerminalTab = useTerminalStore((state) => state.setActiveTab)

    const handleCloseTerminalTab = useCallback(
        (id: string) => {
            closeTerminalTab(id)
            const remaining = useTerminalStore
                .getState()
                .tabs.filter((tab) => tab.location === 'right' && tab.id !== id)
            if (remaining.length === 0) {
                services?.ui?.closeRightPanelTab?.('terminal')
            }
        },
        [closeTerminalTab, services],
    )

    if (rightTabs.length === 0) {
        return null
    }

    return (
        <>
            {rightTabs.map((tab) => {
                const active = tab.id === activeRightTabId
                return (
                    <div
                        key={tab.id}
                        className={cn(
                            'flex h-7 max-w-[160px] shrink-0 items-center gap-1.5 rounded-md px-2',
                            active
                                ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)]',
                        )}
                    >
                        <button
                            type="button"
                            className="flex min-w-0 flex-1 items-center gap-1.5"
                            onClick={() => {
                                services?.ui?.openRightPanelTab?.('terminal', { activate: true })
                                setActiveTerminalTab(tab.id, 'right')
                            }}
                        >
                            <SquareTerminal
                                className="size-3.5 shrink-0 text-[var(--text-muted)]"
                                strokeWidth={1.75}
                                aria-hidden
                            />
                            <span className="truncate text-[12px]">{tab.title}</span>
                        </button>
                        <button
                            type="button"
                            data-testid={`terminal-tab-close-${tab.id}`}
                            aria-label={t('terminal.closeTab')}
                            className="flex size-4 shrink-0 items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                            onClick={(event) => {
                                event.stopPropagation()
                                handleCloseTerminalTab(tab.id)
                            }}
                        >
                            <X className="size-3" strokeWidth={1.75} aria-hidden />
                        </button>
                    </div>
                )
            })}
        </>
    )
}
